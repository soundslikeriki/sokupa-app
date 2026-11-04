# 旧版の入口を止める条件（未実施）

旧919版の`/api/analysis-jobs`はserverのservice権限で直接job／imageを書き込む。**anon RLSを閉じても、この旧API・既に起動した旧workerは停止しない。** 新workerのdisabled設定も、modeを読まない旧workerの停止スイッチではない。外部APIへの旧コードの到達性も、DB遮断だけでは止まったと扱えない。

移行予行39項目で確認したのは、旧版相当のSQL作成／更新と匿名poll／Storage insertの契約で、旧アプリ全体や旧入口の停止を試験したわけではない。service権限の書込みは非公開化後も可能であるため、RLS成功をsealの停止条件に代用しない。

## 読取で確認した現在

本番project `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx` の登録domainは `sokupa-app.vercel.app`。SSO保護はenabled、`all_except_custom_domains`。認証なし・redirect追跡なしのGET `/api/analysis-jobs`で、canonicalは405（旧APIへ到達）、project alias／main branch alias／現在の旧生成URLはVercel Authenticationへ302になった。POSTや実解析はしていない。

これは停止の証拠ではない。認証済みVercel利用者、別の過去deployment、別alias／custom domainを含む全dynamic入口の棚卸しはまだ必要。生成URLのAuthenticationだけを最終停止と見なさない。

`GET /v1/security/firewall/config/active`の読取は404 `Seawall Config not found`だった。既存の全Firewall挙動・利用可能な設定を検査済みとは扱わず、CLI経由の変更や新rule作成は行っていない。

## 停止候補と実証

公式のproject-wide WAFはhostname条件とdenyを扱える。承認されたcanonical hostだけを許し、それ以外の旧生成URL／preview／branch URLを拒否する方法が候補。Hobbyでも最大3 custom rulesがあるが、現在の設定・競合・実際のedge動作は未検証。[条件と作用](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)、[Hobbyの枠](https://vercel.com/docs/vercel-firewall/vercel-waf)

**まだruleをstageもpublishもしていない。** 先に独立QAで作用と誤遮断を確認し、現在のconfig／draft／bypass・aliasを調べる。将来本番へ使う場合は、対象hostを確定してlog→previewで検査→意図したdenyへ段階化する。基本表示・本番callback・canonical wakeを誤遮断しないことを確認する。生成URLへのdenyは、候補deploymentをそのURLで試す手順にも影響する。新app内のmiddleware追加だけでは、過去deployment自体を封鎖できない。

切替は少なくとも次の境界が必要。

1. 本人の既存編集中データと受理済みjobを確認する。旧版の未保存ブラウザ編集が新しいsnapshotへ遡って保存されるとは約束しない。必要な内容を書き出してから合意した保守時間に入る。
2. すべての公開aliasを、旧service APIを持たない保守入口または検証済みの安全な入口へ移し、旧immutable URL等をplatform側で停止する。新しいjob・画像受付も止まる境界にする。今回その操作はしていない。
3. 最後の旧受付以降に旧workerの最大寿命を超える6分以上drainし、旧invocationが終了し、DB／画像更新と新規受付がないことをlog・状態で確認する。古いstuck jobを新しい正規jobと一括処理せず、個別に保持する。
4. 最新DB＋Storageと移行後の差分を再保全する。新client混在や稼働中のまま全pre-cutover行をsealしない。初期scheduled値を仮定せず、新方式を明示的disabledにする。
5. 入口停止が確認できてからPhase 2＋seal、新client、実wake2回の正常完了、本人ID／画像／通知状態を確認して受付する。これはゼロ停止の手順ではなく、保守時間と復旧条件の合意が必要。

旧deploymentの削除や鍵の失効も別案になり得るが、可逆性・他用途・外部APIキーを含む影響が大きく個別確認が必要。DBのservice keyだけを失効させれば全旧機能が停止するとは仮定しない。現在の旧版利用を妨げる操作はしない。

## fallbackの限界

基本表示は同じ認証・DB・worker・計算・保存コードを使うUI fallback。backend障害、計算エンジンや保存処理の障害、hosted DB障害を直す独立系ではない。障害時は受付制御とデータ保全を行い、安全に継続できる仕事をdrainし、修正版／検証済み復旧経路へ進める。旧919への単純alias切戻しやpublic ALL復活、古いdumpによる新job上書きを復旧として実行しない。

この資料は設計と未確認条件の記録。既存の条件付き公開許可を取り消したり、同じSESSION_SECRET／wake操作の再承認を求めたりするものではない。旧入口停止の実証と実機／hosted検証が揃っていないので、今すぐFirewall変更・停止・seal・公開を実行しない。新しい資格情報や追加の権限が必要になれば、既存承認を範囲外へ広げず個別確認する。
