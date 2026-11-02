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
- 解析結果のDB確定後にLINE通知。通知と発注テキストを一つのpushにまとめ、HTTP失敗を検知。ジョブUUIDを最初から再試行キーに使用する。`pending / accepted / failed / uncertain / legacy_unknown` を記録する。`accepted` はLINE API受付を意味し、端末への到着保証ではない。23時間を超えた失敗の自動再送は止める。旧完了ジョブは `legacy_unknown` とし、一括再通知しない。追加マイグレーションでは旧Phase 1適用済みの既定値も明示修正し、過去の不明なpending/failedを監査記録付きで隔離する。要確認の結果は通知に発注テキストを含めない。
- 画像処理全体とvision／catalogの時間をログへ分けて出す。生画像・LINEトークン・セッション値はログに出さない。

## 互換性

- LINEチャネルとLINEユーザーIDは変更しない。独立したデバイスIDの認可実装は現行に存在せず、旧Cookie／localStorageのLINE IDを復元していた。既存端末データは削除せず、同じIDに結び直す。
- 署名のない旧ログインを安全なセッションへ変換するには、**一度だけLINEでの再ログインが必要**。既存登録済みユーザー・管理者・既存無制限ユーザーに新しい招待コードは不要。
- Cookieを保存できない／ログイン途中で別ブラウザへ移る場合、stateを無視せず元のブラウザでやり直す。Safari・iOS PWA・LINE内ブラウザでの実機確認は未実施。
- 移行直前に旧方式で招待コードだけを消費し、LINE登録をまだ完了していない人は、旧Cookieを信頼して通せない。その場合は管理者がコードを再発行する。
- 旧画面を開きっぱなしの利用者は切替後に再読込が必要。旧匿名アップロード・直接DBポーリングは閉じた後には使えない。
- 現行の一括5画像と一般利用者20画像/月を維持。管理者・無制限ユーザーは月間枠を消費しない。月境界は業務に合わせAsia/Tokyoで統一した。

## 移行順序（本番は公開条件の確認待ち）

**追加マイグレーション群とPhase 2のSQLを一括適用しない。** Phase 2は自動マイグレーション対象外の `supabase/rollout/` に置いた。通常のDB migration実行で先に匿名アクセスを閉じる事故を避ける。

1. 独立したSupabase確認環境を用意し、本番スキーマの再現と合成データだけで以下を確認する。ステージングのLINEチャネル／redirect URI、サービスキーは本番と分離する。新しい資格情報の生成・登録・本番設定変更は必要な個別確認後に行う。
2. 現在のユーザー・管理者・無制限一覧、ポリシー、バケット設定、ジョブ状態の安全なバックアップと復元方法を準備する。既存テーブルは公開書込み可能だったため、不審な既存登録がないか利用者・無制限一覧を所有者が確認する。招待履歴欠損だけを理由に既存ユーザーを削除しない。
3. Phase 1 `supabase/migrations/20261102183016_session_api_expansion.sql` と `supabase/migrations/20261102190336_analysis_image_leases.sql`、`supabase/migrations/20261102193554_notification_upgrade_and_worker_health.sql`、`supabase/migrations/20261102203127_verified_worker_success_ticks.sql` を順に確認環境に適用する。旧Phase 1適用済みの履歴は書き換えず追加分を適用する。既存ポリシーは原則維持し、登録／利用枠RPCと通知状態カラムを追加する。補正ログ表と稼働確認表はサーバー専用にする。対応コードより先に必要なRPC／カラムを用意する。
4. `SESSION_SECRET`（32バイト以上、環境別の専用値）を安全に設定する。既存のLINE・Supabase・管理者・内部ワーカー設定を維持し、.env.exampleの全必要項目の存在を値を表示せず確認する。本作業では実秘密を生成していない。
5. 確認環境へ新API／クライアントを配備し、実LINEでの管理者／既存一般（招待履歴NULL含む）／無制限／新規招待／不正セッションの動線を確認する。通常アカウントから管理操作・他人の画像／ジョブにアクセスできないことを確認する。
6. **公開許可の安全条件を満たした後**、本番にPhase 1と新API／クライアントをdisabledで配備する。切替時は旧版の新規受付・旧版の定期ワーカーを止め、旧関数の最大300秒＋余裕として6分以上のdrainを確認する。旧版を処理経路に残したまま新しい定期回復を有効にしない。その後、本人のID、管理者操作、無制限の設定、本人専用のジョブ読取、受付停止を確認する。アップロード・解析の実稼働確認はPhase 2とCron正常稼働確認の後に行う。この段階では旧匿名DB経路のリスクはまだ残るため、Phase 2までを一つの移行作業として扱う。
7. 独立環境で新クライアントの全機能を確認し、本番にはdisabledで新API経路を配備して認証・ID・本人専用読取を確認後、**公開許可の安全条件を満たした切替操作として** `supabase/rollout/20261102183142_restrict_private_data_access.sql` を適用する。敏感な表・レガシー `memo_jobs` ・カタログ表からpublic/anon/authenticated権限を取り除き、RLSを有効にする。memo_uploadsだけを非公開にし、確認済みの公開ポリシーだけを削除する。他バケットのポリシーを削除しない。
8. 匿名／偽装LINE IDでの表読取・変更、画像の一覧／取得／追加／更新が拒否されることを合成データで確認する。管理者本人で一連の機能が使え、既存ID・無制限・行数が変わらないことを確認する。旧URLを持つジョブも管理用SDKで読めることを確認する。Supabase advisorsとポリシー一覧も再確認する。
9. 公開済みデータのコピーは遡って回収できない。既存の公開URLやCDNキャッシュの挙動も確認する。ロールバック時は署名認証とAPI経路を維持した修正を優先し、旧 `public ALL true` を安易に戻さない。Phase 1の追加カラム／関数は残してよく、行の削除・ID変更は不要。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| 変更前 npm test / lint | 21件成功 / 成功 |
| 変更後 npm test | 57件成功。認証・OAuth state・既存NULL招待履歴・所有者・数量・JSON失敗・下書き・通知・ジョブ確定順序・基盤障害時のCron失敗・provider障害分類を合成データとモックで検証 |
| npx tsc --noEmit / npm run lint | 成功 |
| ローカル実Postgres 17.6 | 39項目成功。私有Unixソケットと合成データで8接続の取得・確定・再取得・旧トークン拒否・行ロック・利用枠競合・管理者無制限・稼働判定・利用枠返却の競合を確認。Supabase実サービスとは別 |
| npm run build | 成功。既存由来のlibheif動的requireとBrowserslist古さの警告は残る。Google Fonts取得にはネットワーク許可が必要だった |
| 隔離PostgreSQL (PGlite 0.5.14) | 85項目成功。追加SQLとPhase 2の6本を実行し、匿名／authenticated拒否、サービス権限、招待の一回性とロールバック、上限、無制限、他バケット保全、リースの排他・期限回復・旧トークン拒否・再開回数上限、新旧ワーカー切替の猶予期間を確認。本番には接続しない |
| 定期処理の稼働判定 (PGlite) | 40項目成功。成功2回、失敗後・時間切れ後の再開、重複完了、順序逆転、旧呼出しの拒否、権限制御を確認 |
| 通知アップグレード (PGlite) | 28項目成功。新規と旧Phase 1適用済みの両経路で、過去通知の隔離・監査、既定値、既存ID保持を確認 |
| provider障害と枠 (PGlite) | 51項目成功。再試行・上限・予約月・返却一回性・legacy保全・権限・rollbackを確認 |
| SDK→ワーカー→SQL | 33項目成功。全HTTPをモックし、実SDKの503・認証・通信不明・回復成功と、稼働判定・枠処理を一続きで確認 |
| ブラウザ (一時Chrome、全外部通信を遮断) | 既存9項目＋独立レビュー再現11項目が成功。23m表示、負数拒否、下書き書出し・退避失敗時保全・退避後の解析再開も確認。合成破損画像の失敗表示、リピートON/OFF・再読込・幅数編集・原本復帰・発注下書きの保存／復元・ログインゲート・JS例外なし |

再実行:

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
# optional harness packages are installed outside the repository; these paths are environment-specific
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node scripts/verification/security-migrations.cjs
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node scripts/verification/notification-upgrade.cjs
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node scripts/verification/worker-health.cjs
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node scripts/verification/provider-recovery.cjs
PGLITE_MODULE=/tmp/sokupa-sql-harness/node_modules/@electric-sql/pglite/dist/index.cjs node --import tsx scripts/verification/provider-worker.ts
# start the local server first; fixtures block all non-localhost browser requests
PLAYWRIGHT_MODULE=/tmp/sokupa-sql-harness/node_modules/playwright node scripts/verification/browser-regressions.cjs
PLAYWRIGHT_MODULE=/tmp/sokupa-sql-harness/node_modules/playwright node scripts/verification/independent-review-browser.cjs
```

## 未検証・公開前に解決する点

- 本物のLINE Login／通知到達、Supabase Storage実サービス、iOS Safari／PWA、実画像OCRは未試験。合成データ・モック・PGliteによる確認を実サービス確認と混同しない。
- PGliteはSQL／RLSの検証であり、SupabaseのData API、Storage gateway、CDN、Vercel実行環境の完全な再現ではない。独立Supabase環境での最終確認が必要。
- 76〜238秒の原因は未確定。画像取得、vision、カタログ検索、DB確定、LINE API受付に分けた観測で切り分ける。カタログ検索は既存の最大12ステップを維持しており、時間短縮の実測値はない。
- **中断ジョブの再開にはリースと呼出し元を分けて扱う。** 6分のリース（300秒の関数上限＋余裕）をDBで発行し、期限切れだけを再取得する。完了・失敗の書込みもリーストークンとDB時刻で判定し、古いワーカーの結果は拒否する。初回を含め最大3回で停止し、失敗を明示する。利用枠を再度消費しない。旧running行にもupdated_atから期限を計算する。既存行／旧コードが挿入した画像は、旧300秒ワーカーが終了するまで6分の移行猶予を設ける。新しい作成RPCは即時処理できる。旧挿入経路の通知初期値はlegacy_unknownを維持し、移行中に旧コードが送った通知を再送対象にしない。
- 利用者が画面を開いている／開き直した場合は、本人確認付き `POST /api/analysis-jobs/[id]/resume` が安全に再開する。既存内部シークレット付き `GET /api/analysis-jobs/process` は再開対象を最大3ジョブ取り出し、定期回復に使える。Vercel Cron構成の専用 `CRON_SECRET` のBearerにも対応する。**スケジューラは未設定・未公開**。受付の既定モードはdisabled。2回以上の正常な定期呼出しと直近稼働をDBで確認し、scheduledへ切り替えるまで、画像保存・ジョブ作成・利用者の再開は503で拒否する。閉じたままの継続には、公開前にプラン・頻度・費用を確認してスケジューラを承認・設定する必要がある。短い解析は既存同様に一回のバックグラウンド処理で複数画像を進めるが、30秒経過後は次画像を新しい呼出しへ分ける。
- 外部AI APIの実行とDB保存を一つのトランザクションにはできない。強制終了直前のAI処理が外部で完了していた場合、期限後の再解析で推論料金が重なる可能性は残る。DB結果の二重確定・旧結果の上書き・LINEの重複通知は防ぐ設計とし、外部AI料金までexactly-onceとは主張しない。実Vercelでの強制終了・スケジューラ運用は確認環境での検証が必要。
- LINE API再送は同じキーで行い、受付状態を記録する。旧完了ジョブ・期限超過・不明な成否は自動一括再送しない。実際の到着確認は利用者側で必要。
- 招待コードのIPレート制限は既存のメモリ方式のまま。複数インスタンス横断の永続制限、登録済みアカウントによる大量Storage保存の制限・不要画像の保持期限は別途検討が必要。
- ブラウザ試験は画面＋保存／復元の確認。外部APIをモックし、サーバー→DBの境界はAPIテスト／SQLハーネスで別途確認した。実サービスを通る一続きのE2E試験は未実施。
- 実行中のモデルID／effortを取得・切替するAPIはこの環境にない。ツールの候補には `gpt-6.1-sol` / `gpt-6.1-terra` が表示されるが、最新モデルへの切替完了は確認できない。推論を慎重に進めた。アプリの既存Geminiモデルは変更していない。

参照: [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)、[Supabase changelog](https://supabase.com/changelog)、[LINE retry keys](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)。

## 独立レビュー5件への追補

1. runningの永久停止: DB時刻の期限付きリース、トークンによる書込み制御、3回の上限、本人の再開APIと秘密付き定期回復APIを追加。期限前の二重取得・期限後の再開・旧ワーカーの完了／失敗による上書き拒否・通知1回を回帰確認。
2. 20mが24mになる問題: API・画面・合算で同じロス計算を使用。機械演算の誤差だけを補正し、`2.7×6 + 3.8×1` は23m。20.00000001mのような実際の超過は切上げを維持。
3. 画像全体の要確認: rootのimage_needs_reviewを全品番へ伝搬し、カタログ補完後も保持。通知側も全体・品番・式のフラグを確認し、要確認なら発注文を含めない。
4. 負の幅数・下書き停止: 長さ／幅数／リピートへの負数・非有限入力を拒否。復元失敗時は原文JSONのダウンロードと、読戻し確認付きの別キー退避を用意。退避が失敗した場合は元データを上書きせず停止し、成功後は新規解析できる。解析ボタンの無効状態も実際の準備状態と一致させた。
5. 空OCRが0になる問題: null、空文字、空白、真偽値、配列、オブジェクト等を数値へ暗黙変換しない。読取可能な式も実寸もない場合は失敗。明示された有効な式からの検算は維持。

## 独立再レビューの追補

画面から独立した毎分Cronと受付前の稼働確認を追加し、31秒の1枚目の後に、次の定期呼出しで2枚目が完了する回帰確認を追加した。Cronは未有効化で、設定・費用・個別確認・実環境検証は [ops/cron/README.md](../ops/cron/README.md) に具体化した。旧Phase 1適用済みのdefault修正と過去通知の隔離・監査は追加マイグレーションで行い、新規／旧履歴の両方を28項目検査した。

公開の包括許可は受領済み。ただし独立Supabase、実LINE、iOS等の重大な互換性確認、必要な資格情報・チームアクセスの個別確認、本番バックアップ／復元が未完了のため、公開条件は未充足。本番変更・公開はまだ実施していない。

ローカル実Postgresの追加検証: `scripts/verification/postgres-concurrency.cjs` をPostgres 17.6で実行し、32項目成功。TCPを無効にした私有一時Unixソケットと合成データだけを使い、終了時にDBを削除した。実資格情報は使わず、OSユーザー・外部サービスも作成していない。接続プール／Data APIを含むSupabase実環境の検証は未実施。

## 独立レビュー3回目の追補

DBのジョブ取得・状態確認・確定・失敗記録、通知状態保存、Storageの基盤障害を、保存済みの画像解析失敗と区別する。前者はstatusがfailed/doneでもCronを503にし、失敗した呼出しとして記録する。読めない画像の失敗が正しく保存された場合はワーカー基盤の故障にはしない。LINE送信失敗は従来どおり解析完了とは別の通知状態に保持する。

追加マイグレーション `20261102203127_verified_worker_success_ticks.sql` は呼出しUUIDごとの開始・完了・成否を専用の非公開表に記録する。異なる2件の成功完了と30秒以上の開始間隔が必要。基盤障害または2分超の呼出し停止後は世代を更新し、古い成功・遅れて届く完了を再利用しない。重複完了は一度だけ、成否は上書き不可。6分を超えた完了は成功にしない。履歴は1日保持し、利用者・ジョブ・通知・IDを変更しない。通常のサーバーレスのcold startではDBの履歴を保持し、定期実行が途切れた場合に再確認する。

旧版の開始／完了RPCはservice_roleにも拒否する。アップグレード時はdisabled・旧ワーカーdrain後に追加SQLと対応コードを配備し、新しい呼出し2回の完了を確認する。適用後は旧f71f09fのワーカーへ単純に戻さず、この稼働判定に対応する修正版を使用する。

ローカル実Postgresの32項目には、8接続での同時開始・同じ完了の重複・失敗と古い成功の競合・失敗後2回の回復・期限切れ再起動も含む。画面は今回変更していない。ブラウザ20項目は前回ビルドでの確認結果。

## Provider障害の追補

追加マイグレーション `20261102205248_provider_failure_recovery.sql` を上記4本の後、対応コード配備前に適用する。通常マイグレーション5本とPhase 2は引き続き段階適用する。再試行・利用枠の契約、残る重複課金リスク、旧ジョブの返却制限は [provider-recovery.md](./provider-recovery.md) に記載した。Hobby維持・Proへ変更しないという最新のユーザー方針を継続し、公開・外部設定・鍵生成は未実施。
