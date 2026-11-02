# ソクパ 認証・計算・データ保全の改善

対象コミット: `919379d9e45e367a45d3b6f64b01724a528fe3f2`。
作業場所: `/Users/rikiharada/Documents/Codex/2026-11-03/task/sokupa-app`、ブランチ `codex/security-reliability`。
元チェックアウト `/Users/rikiharada/Documents/Codex/2026-10-13/task/sokupa-app` は未コミット変更なしを確認し、変更せずローカル複製。依存関係は既存 node_modules を読取り利用。package.json / lockfile は変更していない。

**本番への書込み、秘密の生成・登録、LINE送信、実データ／課金AIによる試験、push、merge、デプロイは未実施。** Supabase本番ではスキーマ・ポリシーのメタデータだけを読取り、利用者データは取得していない。

## 実装

- HMAC署名・期限・用途検証付きHttpOnlyセッション。署名のないCookie、localStorage、URL、BearerのLINE IDを認可に使用しない。POSTは同一Originを検証。OAuth stateを厳密に照合する。
- 招待コードの消費をLINE本人確認の後へ移動。登録と消費を同一DBトランザクションで実行し、失敗時は両方を巻き戻す。管理者のコード生成は暗号学的乱数を使う。
- 既存の `users.line_user_id` を維持。既存ユーザーは `invite_code` がNULLでも本人確認後にログイン可能。既存招待履歴をNULLで上書きしない。管理者と `unlimited_users` の月間利用無制限を保持。管理者の既存IDフォールバックも保持。
- 画像を本人確認付きAPI経由で本人のパスに保存。本人のジョブだけを返すAPIへ切替。新規ジョブは所有パスを検証し、外部URLを受け取らない。月間枠の予約・ジョブ・画像行を一つのトランザクションで作成し、同時要求による上限超過を防ぐ。
- OCRワーカーは内部関数を直接呼ぶ。リクエストHostに向けてサーバーHTTPを発行しない。過去の画像URLは同じSupabase・同じバケットだけを許可してオブジェクトパスに変換し、管理用SDKで取得する。これによりバケットを非公開にしても既存ジョブを処理できる設計。
- 同品番の明細を全画像から合算し、合計とロス込み数量を再計算。`2.5×7+4-3` は `2.5×(7+4-3)=20m`。AIの小計・合計を無検証で採用しない。
- `1-30×7` や `2.5×7-3` の曖昧なハイフン表記、式を検算できない場合は理由付きで要確認。画像・品番・式・商品情報の不確かさを区別し、カタログヒットで読取りの要確認を消さない。
- OCRのJSON不正、空の品番／式、画像欠損は失敗として扱う。画像読込・圧縮の失敗とタイムアウトを検知。HEIC変換は順番に行い、複数同時デコードのメモリ負荷を抑える。
- 現場名、編集結果、解析原本、発注下書きを利用者別・バージョン付きで端末保存。不正な保存データは上書きせずエラーにする。新規解析前には直前の下書きも別キーへ退避する。画像プレビュー自体は保存しないため、画像は再選択が必要。
- 実測の元の長さとリピート後の長さを分離。再描画／再読込でリピートを二重適用せず、解除で元に戻せる。元の解析値も保持する。
- 解析結果のDB確定後にLINE通知。通知と発注テキストを一つのpushにまとめ、HTTP失敗を検知。ジョブUUIDを最初から再試行キーに使用する。`pending / accepted / failed / uncertain / legacy_unknown` を記録する。`accepted` はLINE API受付を意味し、端末への到着保証ではない。23時間を超えた失敗の自動再送は止める。旧完了ジョブは `legacy_unknown` とし、一括再通知しない。要確認の結果は通知に発注テキストを含めない。
- 画像処理全体とvision／catalogの時間をログへ分けて出す。生画像・LINEトークン・セッション値はログに出さない。

## 互換性

- LINEチャネルとLINEユーザーIDは変更しない。独立したデバイスIDの認可実装は現行に存在せず、旧Cookie／localStorageのLINE IDを復元していた。既存端末データは削除せず、同じIDに結び直す。
- 署名のない旧ログインを安全なセッションへ変換するには、**一度だけLINEでの再ログインが必要**。既存登録済みユーザー・管理者・既存無制限ユーザーに新しい招待コードは不要。
- Cookieを保存できない／ログイン途中で別ブラウザへ移る場合、stateを無視せず元のブラウザでやり直す。Safari・iOS PWA・LINE内ブラウザでの実機確認は未実施。
- 移行直前に旧方式で招待コードだけを消費し、LINE登録をまだ完了していない人は、旧Cookieを信頼して通せない。その場合は管理者がコードを再発行する。
- 旧画面を開きっぱなしの利用者は切替後に再読込が必要。旧匿名アップロード・直接DBポーリングは閉じた後には使えない。
- 現行の一括5画像と一般利用者20画像/月を維持。管理者・無制限ユーザーは月間枠を消費しない。月境界は業務に合わせAsia/Tokyoで統一した。

## 移行順序（本番は承認待ち）

**二つのSQLを一括適用しない。** Phase 2は自動マイグレーション対象外の `supabase/rollout/` に置いた。通常のDB migration実行で先に匿名アクセスを閉じる事故を避ける。

1. 独立したSupabase確認環境を用意し、本番スキーマの再現と合成データだけで以下を確認する。ステージングのLINEチャネル／redirect URI、サービスキーは本番と分離する。新しい資格情報の生成・登録・本番設定変更は承認後に行う。
2. 現在のユーザー・管理者・無制限一覧、ポリシー、バケット設定、ジョブ状態の安全なバックアップと復元方法を準備する。既存テーブルは公開書込み可能だったため、不審な既存登録がないか利用者・無制限一覧を所有者が確認する。招待履歴欠損だけを理由に既存ユーザーを削除しない。
3. Phase 1 `supabase/migrations/20261102183016_session_api_expansion.sql` を確認環境に適用する。既存ポリシーは原則維持し、登録／利用枠RPCと通知状態カラムを追加する。補正ログ表だけはサーバー専用にする。対応コードより先に必要なRPC／カラムを用意する。
4. `SESSION_SECRET`（32バイト以上、環境別の専用値）を安全に設定する。既存のLINE・Supabase・管理者・内部ワーカー設定を維持し、.env.exampleの全必要項目の存在を値を表示せず確認する。本作業では実秘密を生成していない。
5. 確認環境へ新API／クライアントを配備し、実LINEでの管理者／既存一般（招待履歴NULL含む）／無制限／新規招待／不正セッションの動線を確認する。通常アカウントから管理操作・他人の画像／ジョブにアクセスできないことを確認する。
6. **承認後**、本番にPhase 1と新API／クライアントを配備し、本人のID、管理者操作、無制限、アップロード、ジョブ取得を確認する。この段階では旧匿名DB経路のリスクはまだ残るため、Phase 2までを一つの移行作業として扱う。
7. 新クライアントが匿名DB／Storageへアクセスしていないことを確認後、**別途承認済みの切替操作として** `supabase/rollout/20261102183142_restrict_private_data_access.sql` を適用する。敏感な表・レガシー `memo_jobs` ・カタログ表からpublic/anon/authenticated権限を取り除き、RLSを有効にする。memo_uploadsだけを非公開にし、確認済みの公開ポリシーだけを削除する。他バケットのポリシーを削除しない。
8. 匿名／偽装LINE IDでの表読取・変更、画像の一覧／取得／追加／更新が拒否されることを合成データで確認する。管理者本人で一連の機能が使え、既存ID・無制限・行数が変わらないことを確認する。旧URLを持つジョブも管理用SDKで読めることを確認する。Supabase advisorsとポリシー一覧も再確認する。
9. 公開済みデータのコピーは遡って回収できない。既存の公開URLやCDNキャッシュの挙動も確認する。ロールバック時は署名認証とAPI経路を維持した修正を優先し、旧 `public ALL true` を安易に戻さない。Phase 1の追加カラム／関数は残してよく、行の削除・ID変更は不要。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| 変更前 npm test / lint | 21件成功 / 成功 |
| 変更後 npm test | 38件成功。認証・OAuth state・既存NULL招待履歴・所有者・数量・JSON失敗・下書き・通知・ジョブ確定順序を合成データとモックで検証 |
| npx tsc --noEmit / npm run lint | 成功 |
| npm run build | 成功。既存由来のlibheif動的requireとBrowserslist古さの警告は残る。Google Fonts取得にはネットワーク許可が必要だった |
| 隔離PostgreSQL (PGlite 0.5.14) | 46項目成功。両SQLを実行し、匿名／authenticated拒否、サービス権限、招待の一回性とロールバック、上限、無制限、他バケット保全を確認。本番には接続しない |
| ブラウザ (一時Chrome、全外部通信を遮断) | 9項目成功。合成破損画像の失敗表示、リピートON/OFF・再読込・幅数編集・原本復帰・発注下書きの保存／復元・ログインゲート・JS例外なし |

再実行:

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
# optional harness packages are installed outside the repository; these paths are environment-specific
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node scripts/verification/security-migrations.cjs
# start the local server first; fixtures block all non-localhost browser requests
PLAYWRIGHT_MODULE=/tmp/sokupa-sql-harness/node_modules/playwright node scripts/verification/browser-regressions.cjs
```

## 未検証・公開前に解決する点

- 本物のLINE Login／通知到達、Supabase Storage実サービス、iOS Safari／PWA、実画像OCRは未試験。合成データ・モック・PGliteによる確認を実サービス確認と混同しない。
- PGliteはSQL／RLSの検証であり、SupabaseのData API、Storage gateway、CDN、Vercel実行環境の完全な再現ではない。独立Supabase環境での最終確認が必要。
- 76〜238秒の原因は未確定。画像取得、vision、カタログ検索、DB確定、LINE API受付に分けた観測で切り分ける。カタログ検索は既存の最大12ステップを維持しており、時間短縮の実測値はない。
- **既存waitUntil方式の継続保証は未解決。** 複数画像の合計時間が300秒を超える、またはワーカーが強制終了すると処理が残り得る。重複OCR防止の比較更新は実装したが、runningの画像を無条件で再実行すると課金が重複するため、自動再実行は追加していない。公開前に独立環境で5画像・失敗・再開を確認し、必要なら画像単位の永続キュー／ワークフローを別実装する。`/api/analysis-jobs/process` は既存内部シークレットで1ステップ再開できるが、定期実行の設定はしていない。
- LINE API再送は同じキーで行い、受付状態を記録する。旧完了ジョブ・期限超過・不明な成否は自動一括再送しない。実際の到着確認は利用者側で必要。
- 招待コードのIPレート制限は既存のメモリ方式のまま。複数インスタンス横断の永続制限、登録済みアカウントによる大量Storage保存の制限・不要画像の保持期限は別途検討が必要。
- ブラウザ試験は画面＋保存／復元の確認。外部APIをモックし、サーバー→DBの境界はAPIテスト／SQLハーネスで別途確認した。実サービスを通る一続きのE2E試験は未実施。
- 実行中のモデルID／effortを取得・切替するAPIはこの環境にない。ツールの候補には `gpt-6.1-sol` / `gpt-6.1-terra` が表示されるが、最新モデルへの切替完了は確認できない。推論を慎重に進めた。アプリの既存Geminiモデルは変更していない。

参照: [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)、[Supabase changelog](https://supabase.com/changelog)、[LINE retry keys](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)。
