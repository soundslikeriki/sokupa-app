# 既存URLへ公開するための最短の安全な手順

ユーザー最新方針は「問題なさそうなら、テスト用URLを必須にせず公開する」。公開の包括許可は受領済み。以下は2026-11-03の読取確認と準備結果であり、本番へ変更・配備・秘密生成はしていない。

## 現在の本番と接続

- Vercel: `sokupa-app` / `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx`、チーム `team_KOlFnguSk3s5yqYmQmvZCehz`。現本番deployment `dpl_AZDxpxoziaJP68E7vWJtPNuS7u4V` はREADY、コミット `919379d9e45e367a45d3b6f64b01724a528fe3f2`。作業版はまだ配備していない。
- `https://sokupa-app.vercel.app/` の認証なしHEADは200、redirectなし。生成deployment URLのルートは302でVercel SSOへ転送された。解析・LINE・動的な処理APIは呼んでいない。処理APIの実到達性を確認済みとはしない。
- Vercel Authenticationは `all_except_custom_domains`、パスワード保護／Trusted IPsは無効。保護設定の変更、共有リンク、bypass秘密の生成は不要なまま維持する。[Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- Vercel CLI 51.1.0に既存認証があり、whoami成功を値非表示で確認。`deploy --prod --skip-domain` の引数が使えることもhelpで確認した。ログインを新規開始したり、tokenを生成したりしていない。
- 環境変数は `decrypt=false` のメタデータだけ確認。LINE／Supabase／AIの既存値を取得していない。`SESSION_SECRET`、`ANALYSIS_DISPATCH_SECRET`、`ANALYSIS_DISPATCH_ORIGIN`、`ANALYSIS_BACKGROUND_MODE` は未登録。
- 本番キーの多くがPreviewにも同じ環境変数レコードとして割り当てられている。現在の設定のままPreviewへ配備して本番から分離できたとは扱わない。ユーザーの最新方針どおり、別Preview URLを必須にはしない。

## 今回の公開候補

定期実行を必須にしない **interactive方式** を追加した。[実装と実測](./interactive-execution.md) を参照。旧方式のように受付時のwaitUntilと本人の画面から処理を進める。Cron・pg_net・Vaultの管理権限、定期処理用の秘密は今回の公開の前提から外せる。既存ID、NULL招待履歴、管理者無制限、非公開DB／Storage、provider障害時の受付制御は維持する。既定のdisabledのまま公開完了とは扱わない。

一方、画面を閉じたまま長い複数枚の全処理が完了する保証はない。31秒×2枚は1枚目で待機し、同じLINEで開き直すと続きを処理することを実測した。画面を開いて待つ案内を出す。実LINE・実iPhone・Vercel寿命は未確認のため、「今までどおり」としてこの限界を隠して公開しない。

| 対象 | 不足と最小の操作 | 状態 |
| --- | --- | --- |
| 署名セッション | 32バイト以上の本番専用SESSION_SECRET 1個を生成し、Vercel Productionへ安全登録。LINE／admin値は維持 | 個別承認待ち。生成未実施 |
| 本番バックアップ | Connectの既存DB接続を安全に用意してDB／Storageを保護保存・検査。パスワードをチャットへ貼らない。未保持ならresetせず相談 | 接続準備待ち。本番export未実施 |
| 実環境の互換性 | 対象Vercelの配備への300秒設定反映、署名OAuth・同一ID・admin、iPhone Safari/PWA・下書き・処理・通知を確認できる切替手順 | 実動作は未確認。read-only CLI APIでresourceConfig.fluid=trueを確認 |
| 実サービスの試験 | エージェントがAIやLINEを試す場合、本人宛先・画像枚数・通知回数・費用上限を確認。本人がiPhoneから自ら使う経路も用意 | 実AI・LINE送信を実施していない |
| 定期処理 | 旧signed候補はhosted net／Vault権限条件を満たせない。秘密を載せない別案は未実装・未レビュー | 今回は有効化しない。公開の必須条件にしない |

Supabaseはnet表のプロジェクト別grant／RLS変更をサポートしないと明記している。権限問題をダッシュボードへの再ログインで解決したとは扱わず、supabase_adminの秘密を求めない。[公式制約](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)

## バックアップと復旧の準備

`scripts/verification/local-backup-restore.cjs` で、承認済みの使い捨てnative stackの合成publicスキーマを実pg_dumpし、同clusterの新しい別DBに実pg_restoreした。15表の全行／ID／通知状態、ACLとRLSが一致し、10項目成功。一時の復元DBは削除し、stackも停止した。新しい資格情報は生成していない。

この予行は合成publicスキーマだけで、本番バックアップ、Storage実ファイル、Auth／Vaultの移植を検証したものではない。Freeプロジェクトでは手動exportを用意し、DBバックアップだけでStorageファイルも復元できるとは扱わない。[Database Backups](https://supabase.com/docs/guides/platform/backups)

本番では接続設定を保護したファイル／標準入力から読み、URL・passwordをコマンド引数やログへ載せない。IPv6が使えない場合はConnectのSession poolerを利用し、IPv4有料add-onを無断で追加しない。DBパスワードの再設定も未実施。[公式バックアップ手順](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

バックアップ対象はアプリのユーザー・招待・無制限・利用枠・ジョブ・画像行・通知監査、必要なschema／関数／権限／RLS、Storage設定と実ファイル、適用済みmigration履歴。IDと既存NULL招待履歴を保持し、所有者が既存ユーザー／無制限一覧を確認する。バックアップの保存先はアクセス制限し、hash・件数・復元手順を記録する。

## 条件が揃った後の切替順

公開許可・Vercel接続・Mac内検証の許可は既にある。Hobbyを維持し、Pro化・有料プロジェクト作成をしない。以下の本番操作はまだ実施していない。

1. 最新差分のレビュー、本番バックアップ検査、必要なSESSION_SECRET 1個の承認と設定を先に行う。interactiveの閉画面時の限界と、本人の実確認を含む切替・復旧手順を揃える。
2. 追加migration8本を時刻順に適用し、新コードをdisabledで `deploy --prod --skip-domain` へ用意する。公開ドメインはこの段階で自動切替しない。Phase 2はまだ適用しない。変更前の利用者・無制限一覧と既存ジョブを保護する。
3. 切替の短い保守時間内で新APIへドメインを切替し、旧受付を止めて6分以上drainする。旧worker／関連aliasを処理経路に残さない。本人の同じLINEへの再ログイン、admin、NULL招待履歴、既存下書き、本人専用読取を確認する。LINEチャネルとcallbackは保持する。[LINE callback仕様](https://developers.line.biz/en/docs/line-login/integrate-line-login/)
4. 新API経路と旧worker終了を確認してPhase 2を適用し、匿名DB／Storageアクセスを閉じる。owner読取と匿名拒否、実ファイルの保全を確認する。公開ALLが残る状態で受付を開かない。
5. rootで `select public.set_analysis_execution_mode('interactive');`、Vercel Productionの `ANALYSIS_BACKGROUND_MODE=interactive` を設定して再配備・有効化する。DB／アプリの一致とprivate／provider条件を確認する。Cron、Vault、net権限は変更しない。
6. 本人のiPhoneで写真選択→解析→編集→保存／再読込→発注→通知状態を確認する。複数枚は画面を開いて進行し、閉じた後は開き直して再開することを確認する。PWAでは保存領域がSafariと異なる可能性も含め再ログイン・下書きを確認する。実サービスをエージェントが代行する場合は上表の個別範囲に従う。
7. 認証、ID、管理者無制限、非公開アクセス、画像解析／発注／通知の重大な確認が通り、受付が使える状態になってから公開完了を報告する。disabledの503を残したまま完了扱いにしない。未充足なら保守状態を放置せず、安全な認証・RLSを維持した修正版へ進む／戻す。

全画像の閉画面継続は別リリース。将来scheduledへ切り替える場合は、DB方式変更によって旧health世代が無効になるため、private worker成功2回と時刻・transportの検査を再度行う。今回のために旧signed候補の安全条件を弱めない。

## 障害時

障害時は新規受付disabled、必要ならscheduler停止、drainを先に行う。旧919379d9の匿名DB版にそのまま戻したり、公開ALLを復活させたりしない。署名セッションとRLSを維持する修正版へ戻す／進める。データ復元が必要な場合はバックアップと通知監査を使い、旧通知を一括pendingへ戻さず、送信済みか不明な通知を再送しない。

ユーザーの次の最小確認は「セッション専用秘密1個の生成・本番登録」と「既存DB接続を安全に使う準備」。公開許可は再度求めない。実サービスの代行試験を行う場合だけ、具体的な宛先・枚数・費用範囲も確認する。バックアップ接続の準備や実動作が未確認なので、現時点で直接公開できたとは報告しない。
