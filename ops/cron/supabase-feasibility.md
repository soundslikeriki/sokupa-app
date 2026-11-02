# Supabase Cron候補の実現可能性調査（未実装・未有効化）

2026-11-02。これは設計調査であり、実行用SQL・スケジュール・資格情報ではない。本番への書込み、拡張の有効化、秘密生成、課金変更は行っていない。

## 判断

`pg_cron → pg_net → 既存の定期処理HTTP → 永続ジョブ／期限付きリース` は実装候補になる。ただしSQLを一行足すだけでは採用できない。通信結果の検査、期限付き認証、送信記録、権限、リダイレクトの扱いを追加し、実際の拡張を使った独立検証が必要。現在準備済みのVercel Cron構成を置き換えたとは扱わない。

固定費を抑えられる可能性はあるが、SupabaseのDB・通信、Vercel Functions、AI、LINEの利用量は残る。無料枠内か、追加費用0か、完了時刻や配送が保証されるかは未確定。毎分で43,200起動／30日。空の呼出しでも既存の稼働確認RPCに加え送信・応答検査が増える。

現在のVercelチームはHobby。Hobbyは個人・非商用向けであり、別のスケジューラを使っても業務用途の条件は解決しない。Vercel CronならProは現行表示US$20/月＋利用量・税等。Supabase組織NeoPlusはFree。検証用プロジェクトは無料残枠と対象組織の確認後に見積を取り、非ゼロなら作成前に個別確認する。[Vercel Hobby](https://vercel.com/docs/plans/hobby)、[Vercel料金](https://vercel.com/pricing)、[Supabase課金](https://supabase.com/docs/guides/platform/billing-on-supabase)

## 確認したメタデータと公式制限

| 対象 | 確認内容 |
| --- | --- |
| 本番Supabaseの拡張メタデータのみ | pg_net 0.20.0、supabase_vault 0.3.1は導入済み。pg_cron 1.6.4は利用可能だが未導入。有効化は未実施 |
| 導入版のHTTP設定 | http_getの既定timeoutは5,000ms。batch_size=200、応答TTL=6時間。新しいソースにあるmax_timeout_ms設定はこの環境では未定義。最新版の仕様をそのまま当てはめない |
| Supabase Cron | 推奨は同時8ジョブ以内、各10分以内。今回は毎分1件の短いSQLで非同期HTTPを登録する案。長いHTTPをCronのSQLトランザクション内で待機しない |
| pg_net | トランザクションcommit後に送信。返るのはrequest IDでありHTTP成功ではない。待機キューと応答表はUNLOGGEDで、異常終了時に失われ得る。応答は標準6時間。APIはbeta |
| Vercel | このアプリの関数上限は300秒。pg_netの短い既定timeoutでは処理完了を観測できない。例として310,000msを明示する案だが、実環境での上限・プロキシ・中断挙動を先に試験する |

根拠: [Cron](https://supabase.com/docs/guides/cron)、[pg_net仕様](https://supabase.com/docs/guides/database/extensions/pg_net)、[導入版0.20.0のSQL](https://github.com/supabase/pg_net/blob/v0.20.0/sql/pg_net.sql)、[Vercel実行制限](https://vercel.com/docs/functions/limitations)。メタデータ照会では利用者データ・秘密を取得していない。

## 実装する場合の必須条件

1. **用途を限定した期限付き認証。** Supabase service_role、LINEトークン、SESSION_SECRETをHTTP呼出しの認証に流用しない。別の専用署名鍵をVaultとワーカー側だけに置き、HTTP method・固定host/path・用途・送信UUID・発行時刻・開始期限を署名する案。開始期限は例として2分以内とし、遅れて送信された古いキューはワーカー側で拒否する。署名済みUUIDは一度だけ開始できる設計を追加する。現在の固定Bearer認証にこの機能はまだない。鍵生成・設定は個別承認後。
2. **固定送信先と権限。** 外部入力からURL・ヘッダー・Vault secret IDを指定させない。専用NOLOGINロールと非公開スキーマを用い、anon/authenticatedから呼べない関数にする。SECURITY INVOKERを優先し、Vault全件の復号権限を渡さない。限定した補助関数が必要なら固定秘密だけを読み、PUBLICのEXECUTEを取り消し、権限とadvisorsを独立環境で検査する。
3. **秘密を記録しない。** cron.jobには固定ラッパーの呼出しだけを置く。送信記録にはUUID、分単位のslot、pg_net request ID、期限、状態、HTTP statusとエラー分類だけを保持する。公式サンプルのようにAuthorizationヘッダーを追跡表へ複製しない。netの待機キュー内には送信用ヘッダーが存在するため、権限とDEBUGログ設定も検査する。既存の他用途を調べずnetスキーマ全体の権限を変更しない。
4. **リダイレクトとVercel保護。** 導入版0.20.0はlibcurlのFOLLOWLOCATIONを有効にしている。転送先への秘密の扱いを実証できるまで、長期間有効なVercel保護バイパス秘密を直接渡さない。その秘密は一つのAPIパスだけでなく、プロジェクト内の全deploymentを保護解除できる。固定HTTPSの専用ワーカー入口と期限付き署名、またはredirectを拒否できる制御された中継を別案として検討する。公開範囲の変更や中継の資格情報・費用も個別確認が必要。[pg_net 0.20.0実装](https://github.com/supabase/pg_net/blob/v0.20.0/src/core.c)、[Vercel保護バイパスの範囲](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
5. **送信の重複と応答検査。** 分単位slotのUNIQUE制約とトランザクションロックで同じ起動の二重登録を防ぐ。応答はrequest IDで照合し、200・期待するJSON・エラーなし・タイムアウトなしを検査する。ログインページのHTMLやHTTP受付だけを成功にしない。cron.job_run_detailsのSQL成功をワーカー成功として記録しない。HTTP監視は別のtransport状態に記録し、ワーカー自身の成功2回という条件を偽造しない。採用時はtransport障害でも受付を閉じる判定を追加する。
6. **欠落・再試行・期限。** 永続の送信記録で期限超過を検知し、UNLOGGEDキュー／応答の消失を成功とみなさない。過去のHTTPを無制限に再送せず、次の毎分呼出しで未完DBジョブを再照会する。画像リース・古い書込み拒否・上限3回・LINEの安定した再試行キーを維持する。新旧スケジューラを同時に有効化しない。外部AI実行とDB保存の間の強制終了による再課金の可能性は残る。

## 隔離検証の実現可能性

ローカルの実Postgres 17.6では既存の画像リースと稼働判定を32項目確認した。ただしこのバイナリにはpg_cron/pg_netがなく、PGliteも実際のHTTPバックグラウンドワーカーの代用にはならない。dockerコマンドは現在のPATHで未検出。インストール済みSupabase CLI 2.90.0のstartはコンテナ方式で、native引数も公開されていない。

公式にはDocker/Podman、または実験的なnativeスタックがある。nativeのpg_cronにはCLI 2.121.0以降の修正が必要と記載されているため、現2.90.0で成功する前提にしない。隔離した新しいCLIと公式サービス一式を一時ディレクトリに固定し、localhostだけの合成HTTPサーバーを相手にする方法は実現候補。新ソフトやローカル資格情報の準備はまだ行っていない。[ローカルスタック](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)

次に実施する検証は以下。いずれも未実施であり、結果を先取りしない。

| 検証 | 合格条件 |
| --- | --- |
| 拡張・実cron | 版を固定した実pg_cron/pg_netが毎分localhostへ到達し、2回正常完了を記録 |
| HTTP | 200の正しいJSONのみ正常。401/403/429/500、HTML、空応答、切断、長い応答、DNS失敗を分類 |
| 転送 | 301/302/307で認証・独自ヘッダーが外部へ漏れず、意図しないhost/pathで実行されない |
| 欠落 | DB異常終了で待機キュー／応答が消えても期限超過として閉じ、再開後に成功2回を取り直す |
| 並行 | 同じslotと同じ署名UUIDの並行要求は二重起動せず、古い完了・失敗で新世代を変えない |
| 権限 | anon/authenticatedが秘密・送信記録・呼出し関数へアクセス不可。固定送信先の改変も不可 |
| 実サービス | 許可後の独立Supabaseと独立Vercelで、保護設定、TLS、300秒上限、閉じた画面の複数画像、停止復旧を確認 |

## 残る個別判断

Vercelの業務用途と契約、検証用環境・ソフト準備、専用署名鍵生成と設定、必要なら中継／保護バイパスへのアクセス、費用上限が未確定。本番のpg_cron有効化、Vault登録、定期実行、公開範囲変更はすべて未実施。検証が通るまで現在の受付disabledと公開保留を維持する。
