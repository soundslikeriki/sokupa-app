# iPhone実機を本番から分離して確認する手順

2026-11-04時点の準備。テスト用URL、外部project、LINE callback追加、トンネル、保護bypassは作成していない。旧版のURLと本番DBはそのまま利用できる。専用の実機URLができる前に「iPhone検証済み」とはしない。

## 最短の選択肢

| 経路 | 確認できること | 条件と限界 |
| --- | --- | --- |
| Mac＋同じWi-Fi内の専用HTTPS | Safari／ホーム画面での数量、編集・復元、Cookie、画面を閉じた後のローカル実Cron。callbackを登録すれば実LINEログインも試せる | Mac起動維持、iPhoneで試験CAの明示的な信頼操作、固定のLAN host/IPと証明書SAN、LINE側のcallback受理確認が必要。Vercelの入口／実行上限は検証できない |
| 別Vercel project＋独立Supabase | Macを閉じても、実iPhoneから本番に近いHTTPS・Cookie・Vercel入口・Cronを確認できる | project作成、独立資格情報、LINE callback、アクセス保護、利用枠の確認が必要。既存projectのPreviewを無条件に再利用しない |

Mac内では実Supabase native、pg_cron、pg_net、Vaultを既に起動・検証できる。OSや共有Nodeは変更していない。LANへのbindはまだ行っておらず、localhostのURLはiPhoneから開けない。LAN案ではDB／REST／Storageは127.0.0.1のままとし、公開するのはHTTPSのNext入口1つだけに絞る。全インターフェースへの無条件bind、ルーターのポート開放、公共トンネルは使わない。証明書の警告を無視させず、試験CAを確認して信頼し、終了後にiPhoneから削除する。

継続的なMac稼働を避ける場合は、独立した外部環境が候補。Hobbyは維持し、無料枠が使えるかを作成前に確認する。Supabase Free枠は他組織を含む制限があるため、見えているproject数だけで空きがあると断定しない。有料見積なら作成せず報告する。[Supabase料金と枠](https://supabase.com/docs/guides/platform/billing-on-supabase)、[Vercel環境](https://vercel.com/docs/deployments/environments)

## 分離を成立させる設定

- 対象コードをcommit固定し、環境設定を明示する。ローカルの実データ復元DBは使用しない。合成DBのmarkerとlocalhost接続／独立project IDを確認してから起動する。
- 本番 `yegdgginwcmvpzeiuags` のURL、anon/service key、SESSION_SECRET、Messaging API token、AI key、実画像、dumpをコピーしない。既存 `.env.local` やProductionのenv pullを試験に読み込まない。
- 署名session、招待、adminは試験環境専用。本人のLINE IDを確認する場合も本番users行の変更・device ID再登録はしない。実callbackで確認した本人だけを試験用アカウントとして扱い、第三者を招待しない。
- 実LINEログインの試験には、既存LINE Login channelの利用とsecretをどの試験先へ置くかを個別確認する。同じprovider/channelを使う案ならID維持を確認できるが、外部試験先へのsecret利用を無断で広げない。別providerを作ればIDが変わり得るため、ID互換性の検証に代用しない。
- LINE Developersの既存callbackを残し、**固定した試験originの `/api/auth/line/callback` 1件だけ**を追加する。LINEは複数callbackを設定できる。環境の`LINE_LOGIN_REDIRECT_URI`を同じ値にする。任意return URL、ワイルドカード、state無効化を追加しない。[LINE公式callback設定](https://developers.line.biz/en/docs/line-login/integrate-line-login/#setting-a-callback-url)
- 試験用hostで開始して同じhostに戻す。canonical正規化は本番ではなく試験originへ向ける。URLやログにcode/state/tokenを残さない。プロバイダー認証が必要な操作は本人がiPhone上で行う。
- OCRとMessaging APIは専用試験harnessの合成応答に固定する。試験画面では「解析・通知は合成、実LINE送信なし」と明示する。本番へ配備するコードに無条件の試験認証やmockを混ぜない。実LINE Loginだけを許可する場合も、token/profile以外のLINE APIと実AI通信は拒否する。
- Vercelの保護を広く解除したり、CLIが自動生成するbypass tokenを使ったりしない。本人が既存Vercel Authenticationで開く経路を優先する。Supabase Cronはブラウザの認証Cookieを持たないので、保護された入口からのredirect/401を正常扱いしない。必要なら別の試験専用入口設計を先にレビューする。

現在の`local-wake-next-server.cjs`はlocalhost専用・合成provider固定であり、実LINEログインを許すサーバーではない。そのままLAN／Vercelへ公開しない。実機用入口を用意するときは、上のorigin・認証・送信先の制限と試験表示を組み込んだ専用起動方法を別途確認する。

## 本人が確認する操作

1. Safariで試験URLを開き、招待／LINEログイン→同じ試験hostへ戻る。日本語エラー表示、キャンセル、再試行、canonical以外の開始hostも確認する。Safari／LINE内ブラウザ／PWAのCookieは共有を仮定しない。
2. 合成メモを選び、複数高さのON/OFF、無地／柄、必要量と発注量を確認する。長さと幅数を空欄にして、確認済みの表示が外れることも見る。
3. 保存済み表示を確認し、SafariやPWAを終了・再起動する。前の最新結果と編集が戻ること、新しいアップロードの待ち時間に編集しても消えないことを見る。
4. 31秒以上の合成解析を2枚以上受け付けた後、画面を閉じる。DB／worker側のjob状態で完了を観測し、再度開くまでpoll/resumeリクエストがないことを記録する。LINE通知は合成状態として表示し、実端末到着の検査とは分ける。
5. 試験終了後は試験Cron／入口を停止し、追加callback・試験用アクセス・iPhone試験CAを削除する。本番のcallbackや環境変数は削除しない。

## 個別確認が必要な最小事項

現在は操作待ちの公開URLはない。親からユーザーへ依頼する際は、LAN案か外部案のどちらかに絞り、次の具体的対象を示す。

- LAN案: 同一Wi-FiのiPhoneへ専用HTTPS入口を開くことと、試験CAをiPhoneで信頼する操作。既存ローカル試験用資格情報作成の承認を、ルーター開放や外部継続アクセスの承認へ広げない。
- 実LINE Login: 試験URL確定後、その1件のcallback追加と、LINE Login channel secretを指定試験先に限定利用すること。実Messaging送信と有料AIは含めない。
- 外部案: 指定組織内の独立Supabase／Vercel project、専用資格情報と期間限定Cron、保護の方式。作成前に無料枠と見積を確認し、課金やPro変更はしない。

今回のMac合成試験に新しい有料プラン・実AI料金・LINE送信料金は発生させていない。Mac資源と通信は消費する。外部案や定期wakeは利用枠を消費するため、費用0や実行時刻・通知到達を保証しない。

## 今回確定した最小の承認対象

既存LINE Login channelは **2009808783**。既存callbackは `https://sokupa-app.vercel.app/api/auth/line/callback` で、削除・変更しない。Macのen0の現在のprivate IPv4を読み取り、TCP3443の候補を作成した。**正確なLAN callback候補はrepo外の `sokupa-upgrade-evidence/iphone-approval-target.json` に記録した。まだ入口は起動していない。** DHCPで変わり得るため、承認直前と起動前に同じ値か照合する。登録先が変われば再確認し、別URLへ無断で広げない。

最小案は、新しい外部projectを作らず、MacとiPhoneを同じWi-Fiへ接続して90分以内の試験を行うこと。必要な個別承認は次の組合せになる。

1. LINE Developers Consoleのchannel2009808783のLINE Loginタブに、その**LAN HTTPS callback 1件だけを一時追加**し、試験後にその追加分だけ削除する。Consoleがprivate IPのcallbackを受理するかも、その操作時に確認する。未確認のまま有効と主張しない。
2. 既存の**LINE Login channel secretだけ**を、Mac内の新しい専用QAサーバーへ一時的に限定利用する。ブラウザ、iPhone、Git、Vercel Preview、外部トンネル、第三者へ値を渡さない。本番Supabase key、Messaging token、AI key、本番SESSION_SECRETは使わない。専用QAのDB/session/TLS資格情報はローカル用として分離する。
3. 確認したLAN interfaceのHTTPS3443だけを開き、iPhone上で試験CAの公開証明書のfingerprintを照合して信頼する。必要なmacOSプロンプトは専用Nodeプロセスだけを対象とし、firewall全体を無効化しない。DB／REST／Storageは127.0.0.1に留める。ルーター開放・公共トンネルは対象外。

既存の合成専用Supabaseには実LINE profileを混ぜない。別のローカルQA stackを使い、稼働させるnative stackは1つに限定する。試験で取得する本人profile／IDは専用QAだけに保存し、本番のuser/device登録を更新しない。本人以外の新規登録や招待は許可しない。QA環境は実Loginのtoken/profile endpointだけを許可し、AI／Messagingは合成応答に固定、実送信は拒否する。実Loginに使う認証情報とcode/tokenをログに記録しない。

本人の操作は、同じWi-Fiへの接続、公開試験CAの信頼確認、Safari／LINE内ブラウザ／PWAでの実Loginと画面確認、試験後のCA削除。Macは試験中起動しておく。このLAN試験ではMacを閉じたままのVercel処理は検証できず、端末の画面を閉じたローカルworker処理までが範囲となる。

LINE Login自体は[公式に無料](https://developers.line.biz/en/docs/line-login/overview/)。このLAN案は新しいクラウドホスティング契約・有料AI・Messaging実送信を使わず、追加固定料金は0円の構成。Mac・ネットワーク資源は使用する。クラウド案へ変更する場合は、組織選択／無料枠／見積・秘密の登録先を別途確認し、今回のLAN承認を流用しない。

これらは**未承認・未実施**。正確な候補、秘密の共有範囲、本人profileのQA利用、90分後の停止・追加callback削除をまとめて確認すればよい。資格情報の平文をチャットへ貼る操作は不要。
