# 独立レビュー5219a43への修正

> 別ジョブへの誤紐付けと上書きの追補は [review10-cross-job-draft-protection.md](./review10-cross-job-draft-protection.md) を優先する。

本番未変更。Hobby・閉画面完了・招待・既存LINE ID・管理者無制限は維持する。

## 修正内容

1. **通知待ちの編集が再読込で元に戻る。** 下書きのparsed・originalParsedと同じJSONに、対応するresultJobIdを保存する。再読込時に同じジョブの編集を再適用せず保持する。旧ID欄なしの下書きを元結果一致で補完する方法は、後続review10で廃止した。明示IDがなければ選択と退避を行う。別IDの下書きを同じ仕事とはみなさない。確認済みAPIは、この対応情報を含む書込みと読戻しが成功してから呼ぶ。署名セッションや認可の根拠にローカルjob IDを使わない。
2. **待機中に期限切れとなったpermitを取得。** ロックを取得した後に時刻を取り直し、worker・wake・permitの各待機後に有効期限を検査する。tick作成後にも期限を再検査する。完了・期限回復も待機後の時計を使う。
3. **gap復帰に3回の成功が必要。** 世代のresetを書いた後に発行時刻を取り直す。新permitがreset_atより古くならず、正常な2回で受付を戻す。
4. **mode変更と取得の40P01。** 全wake制御関数をworker→wake→policy／permitの順に統一。共通のSECURITY INVOKER関数でロックし、wakeを持ったままworkerを待たない。新しい権限・拡張所有者への昇格はない。

DBは追加migration `20261103083839_wake_lock_and_clock_order.sql`。旧migrationを書き換えない。既存wake版への適用では旧Cron・受付・制御処理を停止・drainしてから行う。旧関数を実行中のtransactionと、新しいロック順の関数を混在させるhot upgradeを保証しない。今回の本番は旧wake版が未適用だが、将来のupgrade経路として記録する。

## 検証

- 単体65件、型・lint・buildが成功。下書きIDの保持、古いoriginalParsedとの照合、別ジョブの拒否、壊れたIDの保全を確認。
- Chromeでは編集46m／幅数2を再読込して保持。現行とID欄なしの旧下書き×通知failed／acceptedの4組合せ、16項目。既存34項目も成功。すべて合成APIで外部通信は遮断。
- 実Postgres17.6の追加46項目が成功。実ロックで1秒のpermitが待機中に失効する3ケース（worker・wake・permit）と、完了の6分期限を検査。mode停止のcommitと取得が競合しても40P01なし。12回のmixed並行試験も成功。gapの最初のissued_at≥reset_atと、復帰成功2回を実Postgresの精度で検査。
- 権限99、wake107、transport57、旧通知移行28項目も成功。既存Postgres core39／scheduler206は回帰なし。
- 新migrationと最新buildで実Supabase native・実毎分Cron・pg_net・Next HTTPSの25項目も再試験して成功。ブラウザ取得／resumeなしで31秒×2枚を完了し、合算・合成LINE受付1回、401停止・新しい正常2回での復帰を確認した。Cron定義を解除し、Next／stackも停止済み。OCR／LINEは合成応答で、実AI・実LINE送信は0回。

## 公開wakeのRPC消費と悪用

固定URL・空body・同じ204応答は維持。root発行の毎分1件のprivate permitを増やせないため、匿名HTTP要求で新しいジョブ・画像解析枠を作ることはできない。SQLは有効なpermitがない場合、制御行のロックを取らず読み取りだけで戻す。

さらに同じwarm processではclaim中の重複をまとめ、claim照会を最低5秒空ける。合成API試験で同時100要求が1回のRPCになることを確認。これはDB照会のburst抑制であり、認証や分散レート制限ではない。

| 消費 | 抑制と限界 |
| --- | --- |
| 正常な毎分起動 | 30日で43,200 HTTP起動。空の回でも概ね216,000 DB API RPC＋Cron内部SQL。AI・LINEは実仕事分だけ |
| 同じwarm processでの大量要求 | 通常のno-permit照会は最大約12回/分、同時claimは1回。API／Function自体への要求はこの制御前にも消費される |
| 複数process・region・cold startへの分散 | 各processに別のgateができ、全体のRPC上限にはならない。攻撃量や総額をここから確定できない |
| 残るリスク | Function／DB／通信枠の消費、DB待機、Hobby枠の枯渇による停止。AI処理数が増えなくてもDoSは残る |

Hobbyのまま、実利用量とエラー・健康状態を確認する。必要なplatform全体の制限は実際の提供機能・費用・正規Cronへの影響を確認してから個別承認を得る。無料の強いWAF制限・固定送信IP・追加資格情報を仮定して設定しない。5秒gateで定期要求が重なると次のsignalへ延期される場合があるため、120秒のpermitと毎分回復を維持する。

この変更だけで公開許可の安全条件がすべて完了したとは扱わない。最新差分の独立レビュー、本番保全、実LINE／iPhone／Vercel確認と、必要な秘密・外部設定の個別承認は引き続き必要。
