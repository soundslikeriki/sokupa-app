# 独立したHTTPS環境で行うiPhone試験の提案

2026-11-04。第一候補を、独立Vercel project＋独立Supabase project＋同じLINE provider内の専用Developing channelへ変更する。以前のLAN／本番Login secret再利用案は現在の承認依頼に使わない。**外部project、channel、資格情報、callback、Cronはまだ作成していない。** 本番の設定・データは変更しない。

## 対象を限定する

| 対象 | 作成候補と必要権限 | 本番との境界 |
| --- | --- | --- |
| Vercel | team `team_KOlFnguSk3s5yqYmQmvZCehz`（`rikiharada93-2282s-projects`）内の新project `sokupa-iphone-qa`。project作成／配備／QA専用env設定の権限 | 既存 `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx` へ配備しない。既存domain／env／保護を変更しない。Hobby維持 |
| Supabase | 新project `sokupa-iphone-qa`。承認された別組織Sokupa `ipixeawnrdmkurtpcdru`（2026-11-04作成、Free）。NeoPlusは別組織で実障害がある場合だけの代替。**正式見積と接続権限の確認が先**。新projectでschema／RLS／Storage／pg_cron／pg_netを設定できる権限 | `yegdgginwcmvpzeiuags` をbranch／clone元にせず、実データ・Auth・画像・Vault・本番キーをコピーしない |
| LINE Login | 既存channel `2009808783` が属する**同じprovider**内に、新Web App channel `Sokupa iPhone QA`。provider IDをConsoleで照合してから作成。Provider／channel Adminの権限 | 新providerを作らない。本番channelのsecret、callback、公開状態、連携botは変更しない。QAをDevelopingのままにする |
| 本人profile | 実Loginで取得した本人のLINE ID／表示名／画像URLをQAだけに保存する同意。本人だけをAdminまたはTesterとする | 本番user/device紐付けは更新しない。他の人へ招待・メッセージを送らない |

同じprovider内ではchannelが違ってもLINE user IDは共通。[LINE公式ID仕様](https://developers.line.biz/en/faq/) 新channelのDeveloping状態ではAdmin／Testerだけがログインできる。本人のBusiness IDとiPhoneのLINEアカウントの紐付け確認が必要で、Publishedへ変更しない。[Developingでの試験](https://developers.line.biz/en/docs/line-login/getting-started/)

## URLと公開範囲

Vercelの正式なQA Production domainを1つだけcanonicalにし、callbackはそのoriginの `/api/auth/line/callback` とする。**project未作成なので正確なURLはまだ確定していない。** `sokupa-iphone-qa.vercel.app`等を利用可能な確定URLとして案内しない。割当後、project ID／domain所有先／HTTPS／redirectを確認し、登録する1件を記録する。ワイルドカードcallbackを使わない。

初回配備は、QA projectでもVercel上はProduction扱いになる。最初は資格情報なしの準備中ページに限定して正式domainを確定し、その後にQA専用環境を登録する。既存ソクパのProduction配備とは別projectだが、**新しいインターネット公開先になることへの承認**は必要。[初回配備と環境](https://vercel.com/docs/deployments/environments)

Vercelは`.vercel.app`へ信頼されたHTTPSを提供するため、iPhoneへの新規CA信頼やMacのLAN開放は不要。[TLS仕様](https://vercel.com/docs/cdn-security/encryption) QA用manifest名を「ソクパQA」、画面を「検証環境：解析・通知は合成」と区別し、既存のホーム画面アプリを置換しない。

CronはVercelのログインCookieを持てない。QAのcanonical Production domainをapp認証で保護する案を明示して承認を得る。UIの入口は公開されるが、個人データ／job／画像は署名sessionとowner照合、Developingの本人制限、private RLS／Storageで保護する。public wakeは空bodyの起動通知だけで、DB内の限定permitで1枠だけ処理する。QAも全URL保護の設定なら、401／redirectを失敗として止める。保護bypass tokenを作らず、既存ソクパの保護を解除しない。[Deployment Protection](https://vercel.com/docs/deployment-protection)

## 新しい資格情報の保存先

| 値 | 保存・共有先 |
| --- | --- |
| QA Supabase service key | 新QA projectのserver envだけ。ブラウザへ出さない |
| QA Supabase URL／publishable key | 新QA projectだけ。本番refをpreflightで拒否する |
| QA SESSION_SECRET | 新規の専用値をQA server envだけへ登録。本番署名鍵を再利用しない |
| 新QA LINE Login channel ID／secret | 新QA server envだけ。既存2009808783のsecretはコピーしない |
| LINE access token／認可code | OAuth処理のメモリだけ。ログやDBへ保存しない |
| Messaging token／有料AI key | **QAには登録しない**。実通知・有料解析をしない |

QA作成・専用鍵・本人profile利用・専用Developing channel・限定HTTPS入口は個別承認済み。無料枠・利用枠・ローカル検証を満たすまで外部project／鍵は未作成。承認後もチャット、Git、build logへ平文を出さず、QA project IDを確認して保護したstdin等で扱う。QA sourceはGitの追跡対象だけから別directoryへ用意し、現在の`.vercel`リンク・`.env.local`・repo外の本番バックアップをコピー／uploadしない。Management tokenやDB root passwordをアプリへ渡さない。

## 配備前に必要な実装・検査

1. 空のSupabaseへ入れる最小schemaを再現可能に用意する。repoの古いmigrationを一括実行して本番と同じになると仮定しない。users／invite等の初期定義と12本の追加SQL、非公開化、明示的disabled、空のlegacy境界を確認する。新projectのmigration履歴・権限・拡張も検査する。実データdumpを初期化に使わない。
2. **QA専用provider adapterはローカル実装済み。hosted検証が必要。** 現在のlocalhost用custom serverをそのままVercelへ配備しない。承認されたQA project ID＋QA DB ref＋期限が一致した時だけ、31秒の合成OCRと合成通知を使えるようにする。実project ID/ref、実Messaging／AI資格情報の混入、guard不成立では起動・処理を拒否する。通常版へmockが有効になる経路を作らない。
3. LINEの実通信は専用channelのtoken交換と本人profile取得だけ。callback origin／state／署名session、既存IDと同じproviderであることを照合する。初回だけでなく、同意済みの2回目、キャンセル、alias開始、Safari／LINE内ブラウザ／PWAを確認する。
4. QAだけで毎分wakeを期限付きで有効化する。90分なら最大約90回の定期HTTPに、本人操作とworker処理が加わる。2回のprivate成功、31秒画像2枚、画面を閉じてpoll/resumeなしでの完了、401等での受付停止と復帰を実Vercel＋Supabaseで観測する。
5. 通知は画面にも合成と明示する。LINE端末到達と実写真のOCR精度はこの試験に含めず、必要なら別の限定した実送信／AI予算の承認を取る。
6. 終了時はQA Cron停止、QA資格情報失効／削除、QA projectと専用channelの後片付けを行う。既存provider・本番channel・本番projectを削除しない。期限／cleanupの範囲も作成前に確認する。

## 費用と現在の未確定事項

- Vercel Hobbyは無料プランで、QAも同じplanの利用枠を消費する。Pro、独自domain購入、有料integrationを追加しない。[Hobby](https://vercel.com/docs/plans/hobby)
- LINE Loginは無料。専用Login channelだけを使い、Messaging送信は0件とする。[LINE Login](https://developers.line.biz/en/docs/line-login/overview/)
- Supabase Free枠が利用可能なら追加固定料金0円の候補。ただし全Owner／AdminにまたがるFree2project制限があり、見えるprojectが1件でも作成可能とは断定できない。[Free制限](https://supabase.com/docs/guides/platform/billing-faq)
- 別組織Sokupaの作成先・無料限定のQA範囲は承認済み。公式画面でFreeと使用量0を確認したが、コネクタの新組織権限が反映されず正式見積は未取得。接続を更新してからSokupaだけで`get_cost`を行い、非0なら作成しない。

残るリスクは、QA公開URLへの不要アクセスによる利用枠消費、Developing用LINEアカウントと本人アカウントの違い、provider選択ミス、QA資格情報の混入、端末間cookie差、実Vercel処理の上限／障害である。QAは本番channelとは別なので、QA合格を本番Login・実LINE配送・実AI精度の確認済みと拡大しない。実データ移行39項目と基本表示fallbackは、これら実機／hosted確認の代用にはしない。

## 2026-11-04 13:28 UTC の実施結果と次の操作

本人指定どおり、同じ既存アカウント内に新しいFree組織「Sokupa」を公式画面で1回作成した。ID `ipixeawnrdmkurtpcdru`。NeoPlusのrename／move／削除は行っていない。公式組織画面でproject0、Egress0/5GB、DB0/500MB、Storage0/1GB、MAU0/50,000を確認した。情報提供のTerms更新noticeのみで、明示的な規約同意操作は出ていない。

接続済みコネクタは新組織をまだ列挙せず、`get_organization`／`get_cost`はpermission denied（-32600）。見積・project作成は停止、別ツールによる拒否迂回はしない。必要なのは既存Supabase接続で新組織Sokupaを対象に追加承認／再接続すること。新しいキーそのものをチャットへ渡す必要はない。アクセス確認後に同じ対象を状態確認してから一度だけ見積を再試行し、非0なら止める。

ローカル準備：`ops/qa/clean-base.sql`は空public schemaのみ受付、既存Storage/Authをコピーせず最小app schemaを作る。12本の202611 migration→明示disabled→Phase2/空seal→`ops/qa/limits.sql`の順序。rootだけが本人ID／開始・終了時刻を1行設定する。QAに限り最大90分、10job／20画像、40upload試行／累計80MiBをDBで制限する。upload失敗も消費し、無限再試行を防ぐ。本番管理者の無制限枠は変更しない。

`qa-runtime.ts`の合成adapterは専用Vercel project ID・Supabase ref・本人ID・新LINE channel ID・callback origin・専用キーのSHA256・開始／終了時刻を照合する。source project/ref/channel、混入したAI／Messaging資格情報、片方だけのQA設定、期限切れでfail closed。31秒OCRと通知は合成、Google検索も実行しない。署名sessionの他人IDはDB照会前に拒否する。OAuth token交換と本人profile取得は専用LINEの実通信なのでhosted試験が残る。

QAの90分TTLは処理を止めるが、public入口への不要リクエスト自体のプラットフォーム消費は完全には止めない。Vercel共有枠の使用量と試験停止閾値（残量が試験予算未満／想定外traffic発生でQAを停止）を確認してから配備する。Supabase新組織の利用枠と全Ownerの2active無料project制限も別々に確認する。`ops/qa/wake-ttl.sql`は期限切れ時にwake／受付をdisabledにし、QA専用scheduleだけを解除する。ローカルSQLのCron／ネットワーク部分はfixtureであり、実pg_cron／pg_netとの新adapter統合は未検証。終了後はCron停止→QA TTL停止→個別資源の削除確認。本番鍵・実データ・AI・LINE送信を使わない。

本人のiPhone操作は正式QA URLと専用LINE設定ができてから案内する。接続権限が未更新のため現時点で開始時刻は確約できず、15:00UTC公開は未確約。既存の本番公開／SESSION_SECRET／wake承認の再確認は不要だが、本番切替に必要な実機と入口退役の安全条件は未達。

## 実拡張とのローカル統合結果（13:47 UTC）

新adapterを含むQA用Next buildを、既存の使い捨てnative Supabaseへ接続して26項目を確認した。実pg_cron／pg_net／Vault、private Storage、実HTTP署名session、2回の独立した実Cron/private成功、31秒画像2枚がpoll/resumeなしに40m／発注46mへ完了、合成通知1回、本人quota0、QA job/upload上限記録、実Cronによる期限切れ自己解除とdisabled、期限後の再受付拒否・session／OAuth開始拒否が通った。Google／LINEへのfetchは試験serverが遮断し、合成応答は出荷コードのQA adapter自身が返す。実OAuthやiPhone到達の代用にはしない。

既存native platform schemaへQA限定marker/limitsを加える結合試験であり、空hosted Supabaseの初期化は別のfresh PG84項目による確認。初回cleanupはfixtureの親子FKにより失敗したため、子画像→親jobの順へ修正し、正確な同一手順を実行してQA画像・job・user・cap・Cronの除去、元の2合成user、disabled状態を確認した。26機能項目とcleanupの証跡は別々に保持し、初回プロセス全体の終了コード0とは報告しない。

13:47 UTC、ツールmetadataが更新され、正式な`link_id`選択が利用可能になった。新接続Sokupa（`link_6aeb35dcab2481918a368dc3f75151b2`）のlist_organizationsはSokupa組織`ipixeawnrdmkurtpcdru`だけを返した。旧Primaryの拒否を別手段で迂回したものではなく、新しく承認された接続対象の通常の組織一覧。get_cost／project作成はこの確認段階では未実施で、親の作成保留を維持している。
