# 独立したHTTPS環境で行うiPhone試験の提案

2026-11-04。第一候補を、独立Vercel project＋独立Supabase project＋同じLINE provider内の専用Developing channelへ変更する。以前のLAN／本番Login secret再利用案は現在の承認依頼に使わない。**外部project、channel、資格情報、callback、Cronはまだ作成していない。** 本番の設定・データは変更しない。

## 対象を限定する

| 対象 | 作成候補と必要権限 | 本番との境界 |
| --- | --- | --- |
| Vercel | team `team_KOlFnguSk3s5yqYmQmvZCehz`（`rikiharada93-2282s-projects`）内の新project `sokupa-iphone-qa`。project作成／配備／QA専用env設定の権限 | 既存 `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx` へ配備しない。既存domain／env／保護を変更しない。Hobby維持 |
| Supabase | 新project `sokupa-iphone-qa`。候補組織は既存NeoPlus `edsiqphjayhfyfiyqgyb`。**作成先組織の本人確認と見積が先**。新projectでschema／RLS／Storage／pg_cron／pg_netを設定できる権限 | `yegdgginwcmvpzeiuags` をbranch／clone元にせず、実データ・Auth・画像・Vault・本番キーをコピーしない |
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

鍵を作る／Vercelへ登録する操作は未承認・未実施。承認後もチャット、Git、build logへ平文を出さず、QA project IDを確認して保護したstdin等で扱う。QA sourceはGitの追跡対象だけから別directoryへ用意し、現在の`.vercel`リンク・`.env.local`・repo外の本番バックアップをコピー／uploadしない。Management tokenやDB root passwordをアプリへ渡さない。

## 配備前に必要な実装・検査

1. 空のSupabaseへ入れる最小schemaを再現可能に用意する。repoの古いmigrationを一括実行して本番と同じになると仮定しない。users／invite等の初期定義と12本の追加SQL、非公開化、明示的disabled、空のlegacy境界を確認する。新projectのmigration履歴・権限・拡張も検査する。実データdumpを初期化に使わない。
2. **QA専用provider adapterは別途実装・検証が必要。** 現在のlocalhost用custom serverをそのままVercelへ配備しない。承認されたQA project ID＋QA DB ref＋期限が一致した時だけ、31秒の合成OCRと合成通知を使えるようにする。実project ID/ref、実Messaging／AI資格情報の混入、guard不成立では起動・処理を拒否する。通常版へmockが有効になる経路を作らない。
3. LINEの実通信は専用channelのtoken交換と本人profile取得だけ。callback origin／state／署名session、既存IDと同じproviderであることを照合する。初回だけでなく、同意済みの2回目、キャンセル、alias開始、Safari／LINE内ブラウザ／PWAを確認する。
4. QAだけで毎分wakeを期限付きで有効化する。90分なら最大約90回の定期HTTPに、本人操作とworker処理が加わる。2回のprivate成功、31秒画像2枚、画面を閉じてpoll/resumeなしでの完了、401等での受付停止と復帰を実Vercel＋Supabaseで観測する。
5. 通知は画面にも合成と明示する。LINE端末到達と実写真のOCR精度はこの試験に含めず、必要なら別の限定した実送信／AI予算の承認を取る。
6. 終了時はQA Cron停止、QA資格情報失効／削除、QA projectと専用channelの後片付けを行う。既存provider・本番channel・本番projectを削除しない。期限／cleanupの範囲も作成前に確認する。

## 費用と現在の未確定事項

- Vercel Hobbyは無料プランで、QAも同じplanの利用枠を消費する。Pro、独自domain購入、有料integrationを追加しない。[Hobby](https://vercel.com/docs/plans/hobby)
- LINE Loginは無料。専用Login channelだけを使い、Messaging送信は0件とする。[LINE Login](https://developers.line.biz/en/docs/line-login/overview/)
- Supabase Free枠が利用可能なら追加固定料金0円の候補。ただし全Owner／AdminにまたがるFree2project制限があり、見えるprojectが1件でも作成可能とは断定できない。[Free制限](https://supabase.com/docs/guides/platform/billing-faq)
- 今回の読取では組織NeoPlusとactive本番project1件を確認した。**組織を推測せず、本人に作成先を確認してから`get_cost`で実見積を取る必要があるため、見積は未取得。** 非0見積なら作成・課金せず金額と代替を報告する。無料見積と対象を提示して、QA作成・鍵・公開先の承認を得てから進める。

残るリスクは、QA公開URLへの不要アクセスによる利用枠消費、Developing用LINEアカウントと本人アカウントの違い、provider選択ミス、QA資格情報の混入、端末間cookie差、実Vercel処理の上限／障害である。QAは本番channelとは別なので、QA合格を本番Login・実LINE配送・実AI精度の確認済みと拡大しない。実データ移行39項目と基本表示fallbackは、これら実機／hosted確認の代用にはしない。

## ユーザーへ提示する最小の確認文

「QA用DBの作成先は現在のNeoPlusでよいですか。見積を確認し、追加固定料金0円の場合だけ、独立Vercel／Supabaseと同じLINE providerの本人限定Developing channel・専用鍵を作り、検証用URLを公開してよいですか。LINE実送信・有料AI・本番変更はせず、検証終了後は停止・専用設定を後片付けします。」

組織確認後にget_costの実見積を提示し、費用条件と作成範囲への理解を確認してから作成する。見積非0や別対象への変更は停止して相談する。これは本番の公開許可・既存SESSION_SECRET／wake承認の再確認ではなく、新しいQA資源・資格情報・LINE設定・公開先への個別確認である。既存本番の署名鍵は登録済みを保全し、理由なく再生成しない。
