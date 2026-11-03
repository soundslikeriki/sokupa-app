# 既存URLへ公開するための最短の安全な手順

> 5219a43の独立レビュー4件への追加修正は [時刻・ロック・下書き・公開入口の評価](./review9-locks-drafts-and-abuse.md) を参照。適用済みwake版からの移行は旧制御処理をdrainする。

ユーザー最新方針は「問題なさそうなら、テスト用URLを必須にせず公開する」。公開の包括許可は受領済み。以下は2026-11-03の読取確認と準備結果であり、本番へ変更・配備・秘密生成はしていない。

## 現在の本番と接続

- Vercel: `sokupa-app` / `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx`、チーム `team_KOlFnguSk3s5yqYmQmvZCehz`。現本番deployment `dpl_AZDxpxoziaJP68E7vWJtPNuS7u4V` はREADY、コミット `919379d9e45e367a45d3b6f64b01724a528fe3f2`。作業版はまだ配備していない。
- `https://sokupa-app.vercel.app/` の認証なしHEADは200、redirectなし。生成deployment URLのルートは302でVercel SSOへ転送された。解析・LINE・動的な処理APIは呼んでいない。処理APIの実到達性を確認済みとはしない。
- Vercel Authenticationは `all_except_custom_domains`、パスワード保護／Trusted IPsは無効。保護設定の変更、共有リンク、bypass秘密の生成は不要なまま維持する。[Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- Vercel CLI 51.1.0に既存認証があり、whoami成功を値非表示で確認。`deploy --prod --skip-domain` の引数が使えることもhelpで確認した。ログインを新規開始したり、tokenを生成したりしていない。
- 環境変数は `decrypt=false` のメタデータだけ確認。LINE／Supabase／AIの既存値を取得していない。`SESSION_SECRET`、`ANALYSIS_DISPATCH_SECRET`、`ANALYSIS_DISPATCH_ORIGIN`、`ANALYSIS_BACKGROUND_MODE` は未登録。
- 本番キーの多くがPreviewにも同じ環境変数レコードとして割り当てられている。現在の設定のままPreviewへ配備して本番から分離できたとは扱わない。ユーザーの最新方針どおり、別Preview URLを必須にはしない。

## 今回の公開候補

最新要件は「画面を閉じたまま全画像を処理し、他の仕事ができる」。interactive方式は不採用で、後続migrationで受付も無効にした。**秘密を載せない毎分wake＋非公開DB実行許可** を実装し、実Cron・pg_net・Next HTTPS入口から2枚をブラウザ再開なしで完了する試験が通った。[実装と実測](./closed-screen-execution.md)

既存ID、招待、NULL招待履歴、管理者無制限、非公開DB／Storageを維持する。公開HTTPは固定URL・空bodyで、鍵やユーザー／画像IDを流さない。net表の所有者・grant変更、Vault、新しいdispatch秘密、Pro化は不要。ただし新たな毎分の起動と公開wake入口の外部設定は個別確認後に行う。既定disabledのまま公開完了にはしない。

| 対象 | 不足と最小の操作 | 状態 |
| --- | --- | --- |
| 署名セッション | 32バイト以上の本番専用SESSION_SECRET 1個を生成し、Vercel Productionへ安全登録。既存LINE／admin値を維持 | 個別承認待ち。生成未実施 |
| 定期起動 | 対象Supabaseでpg_cronを有効化し、正確な本番originへの空HTTPを毎分1件。ANALYSIS_WAKE_ENABLEDとroot設定を有効にする | SQL雛形とローカル検証済み。本番設定は個別承認待ち |
| 本番バックアップ | 既存DB接続を安全に用意し、全アプリschema／役割／履歴とStorage metadata・全実byteを保護保存・検査 | 本番export未実施。[具体的保全計画](./production-backup-plan.md) |
| 実環境の互換性 | 実Vercel入口・Function寿命、署名OAuth・同一ID・admin、本人iPhone/PWAの閉画面処理と通知を確認 | read-only CLI APIでFluid=true。Vercel上の新方式・実LINE・実機は未確認 |
| 実サービスの試験 | エージェント代行なら本人宛先・画像枚数・通知回数・費用上限を確認。本人のiPhone操作も選べる | 実AI・LINE送信0。代行範囲は未承認 |
| 独立レビュー | 最新wake・復元・通知修正の差分をレビュー | 5a3140a以後の差分は未レビュー |

Supabaseはnet表のプロジェクト別grant／RLS変更をサポートしないと明記している。制約を受け入れ、ネットワークへcredentialを載せない設計にした。公開HTTP204だけではhealthyにならず、private worker完了2回を必要とする。[公式制約](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)

## バックアップと復旧の準備

最新の合成予行は全アプリ／運用21表＋Storage 11ファイルを対象とし、実pg_dump・別DBへの実pg_restore、全byteの別private bucket復元が成功した。14項目で行・ID・通知・方針・関数・RLS・table／column ACL・SHA256を検査した。試験コピー・DB・bucketを削除し、Cron定義0とstack停止を確認した。

本番のAuth／Vault／platform全体やStorage IDの別project完全移植までは実証していない。現本番のバックアップは未取得。[対象の棚卸し、取得・検査・復旧の具体手順](./production-backup-plan.md) に従う。passwordをチャット・引数へ載せず、パスワードresetや有料接続add-onを無断追加しない。

## 条件が揃った後の切替順

公開許可・Vercel接続・Mac内検証の許可は既にある。Hobbyを維持し、Pro化・有料プロジェクト作成をしない。以下の本番操作はまだ実施していない。

1. 最新差分のレビュー、本番バックアップ検査、必要なSESSION_SECRET 1個の承認と設定を先に行う。固定本番originへの毎分wake設定を個別確認し、本人の閉画面実確認を含む切替・復旧手順を揃える。
2. 追加migration11本を時刻順に適用し、新コードをdisabledで `deploy --prod --skip-domain` へ用意する。公開ドメインはこの段階で自動切替しない。Phase 2はまだ適用しない。変更前の利用者・無制限一覧と既存ジョブを保護する。
3. 切替の短い保守時間内で新APIへドメインを切替し、旧受付を止めて6分以上drainする。旧worker／関連aliasを処理経路に残さない。本人の同じLINEへの再ログイン、admin、NULL招待履歴、既存下書き、本人専用読取を確認する。LINEチャネルとcallbackは保持する。[LINE callback仕様](https://developers.line.biz/en/docs/line-login/integrate-line-login/)
4. 新API経路と旧worker終了を確認してPhase 2を適用し、匿名DB／Storageアクセスを閉じる。owner読取と匿名拒否、実ファイルの保全を確認する。公開ALLが残る状態で受付を開かない。
5. 承認後、pg_cron有効化とreview済みwake雛形を適用する。rootの方式をscheduled-wake、originを `https://sokupa-app.vercel.app` に固定。ANALYSIS_WAKE_ENABLED=true、app mode=disabled／expect_processing=falseで空のwarmupを実入口から確認する。root設定・app modeをscheduled-wake／expect_processing=trueへ揃え、reset後の独立したprivate成功2回＋HTTP確認で受付を開く。Cronは毎分1件のreconcile→enqueueだけにする。net／Vault権限やVercel保護bypassを追加しない。
6. 本人のiPhoneで写真選択→解析→編集→保存／再読込→発注→通知状態を確認する。複数枚を受け付けた後に画面を閉じ、開き直しや再開要求なしで最後まで処理・通知されることを確認する。PWAでは保存領域がSafariと異なる可能性も含め再ログイン・下書きを確認する。実サービスをエージェントが代行する場合は上表の個別範囲に従う。
7. 認証、ID、管理者無制限、非公開アクセス、画像解析／発注／通知の重大な確認が通り、受付が使える状態になってから公開完了を報告する。disabledの503を残したまま完了扱いにしない。未充足なら保守状態を放置せず、安全な認証・RLSを維持した修正版へ進む／戻す。

閉画面での全画像継続は今回の公開条件。開き直し依存のinteractive版を先に公開しない。方式変更では旧health世代を無効にし、private成功2回と実開始の間隔・時刻・transportを検査する。旧signed候補の安全条件を弱めない。

## 障害時

障害時は新規受付disabled、必要ならscheduler停止、drainを先に行う。旧919379d9の匿名DB版にそのまま戻したり、公開ALLを復活させたりしない。署名セッションとRLSを維持する修正版へ戻す／進める。データ復元が必要な場合はバックアップと通知監査を使い、旧通知を一括pendingへ戻さず、送信済みか不明な通知を再送しない。

ユーザーの次の最小確認は「セッション専用秘密1個の生成・本番登録」と「毎分の秘密なしwake／公開入口の本番設定」。既存DB接続を安全に使う準備も必要。公開許可は再度求めない。実サービスの代行試験を行う場合だけ、具体的な宛先・枚数・費用範囲も確認する。バックアップ接続の準備や実動作が未確認なので、現時点で直接公開できたとは報告しない。
