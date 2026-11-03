# 画面を閉じたまま処理する方式

> 保留結果の端末保管・本人履歴と受付失敗後の復元は [review12-deferred-result-recovery.md](./review12-deferred-result-recovery.md) を参照。別端末の確認済み情報で、この端末の保留結果を破棄しない。

> 通知待ちと新規解析の分離は [review11-notification-analysis-separation.md](./review11-notification-analysis-separation.md) を参照。done後の通知failedは次の解析をロックしない。

> 端末に別の編集がある場合の復元は [下書きの選択・退避・復元](./review10-cross-job-draft-protection.md) に従う。旧形式のOCR内容一致だけでジョブへ自動紐付けしない。

> 最新の4件修正と公開wakeのRPC消費評価は [review9-locks-drafts-and-abuse.md](./review9-locks-drafts-and-abuse.md)。追加migrationでロック順・待機後の時計・2回復帰を修正し、下書きにjob対応を保存する。

2026-11-03。ユーザーの「放置して他の仕事ができる」を必須条件とし、開き直し依存のinteractive方式を公開対象から外した。後続migrationでinteractiveの受付も無効にした。既存LINE ID、招待、NULL招待履歴の既存ユーザー、管理者無制限、端末下書きは維持する。本番は未変更。

## 実装

`Supabase毎分Cron → 空のpg_net HTTP → Nextのwake API → 非公開DBの期限付き実行許可 → waitUntil → 画像リース → OCR → 結果確定 → LINE受付`。

実行許可はroot/Cronだけが毎分1件まで作る。公開HTTPはURL固定・body空のJSON・認証headerなし。permit ID、ユーザー／画像ID、署名、既存サービスキーを一切載せない。サーバーは既存のservice_roleで、非公開DBに実在する期限内の許可を一つだけ取得する。送り手、body、query、任意job_idは認可根拠にしない。応答は成功・失敗とも情報のない204で、稼働状態やIDを返さない。

pg_net表は他ロールから読める前提。権限・所有者・RLSを変更しない。Vaultも定期処理専用の新しい鍵も不要。全関数はSECURITY INVOKER。service_roleにも実行許可のINSERT、設定有効化、origin変更、transport成功記録は許さず、取得・完了に必要な既存行の列だけ更新できる。Supabaseの制約を回避したものではない。[pg_netの公式制約](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)

公開入口への大量要求によるFunction・DB RPCの消費は残る。HTTP要求回数が増えても許可数・AI処理数を増やせないが、DoSや利用枠消費を完全に防ぐとは主張しない。公開前レビューと利用量監視が必要。プラットフォームの防御や追加の有料制限を無料・無制限と仮定しない。

## 完了・再開と稼働判定

- 実行許可の取得期限は120秒。取得トークンとprivate tickを結び付ける。同時要求でも取得は1回。
- 仕事は既存の6分画像リースで排他し、古いワーカーの結果を拒否。1回の処理開始予算30秒を超えた次の画像は、次回Cronが進める。最大300秒のFunctionが終了しても、期限後のリースを次回Cronで回復する。既存の最大3回と利用枠の一回性を維持する。
- LINEは同じjob UUIDの再試行キーを使用。HTTP失敗を通知状態へ保存し、23時間を超えた不明な再送は止める。API受付は端末到達の保証とは区別する。
- 公開HTTPの204だけではhealthyにならない。private permitの成功、対応するprivate worker成功、root observerのHTTP確認が必要。独立した2回と、発行・実開始の30秒以上の間隔、世代・期限を検査する。
- 401／TLS／timeout／redirect先のHTML等の観測失敗、enqueue・観測例外、取得／worker期限切れでは世代を更新して受付を閉じる。古い完了で復帰しない。2つの新しい正常処理を確認して復帰する。HTTP異常をDBが知るのは次のobserver実行時、通常1分以内であり、瞬時の検知保証ではない。
- scheduler停止は直近2分の時刻条件でも受付を閉じる。providerの認証障害・cooldown、非公開DB／Storageも別途必須。利用枠は受付前の拒否で消費しない。

`ANALYSIS_BACKGROUND_MODE=scheduled-wake` とDB側の同じ方式、`ANALYSIS_WAKE_ENABLED=true` とroot設定が一致して初めて処理可能。既定はdisabled／wake無効で、migrationだけでは外部呼出しもCronも始まらない。HobbyのFluid設定trueはメタデータで確認済み。waitUntilもFunctionの実行上限で終了し、ホストの停止中まで完了時刻を保証するものではない。[Vercel duration](https://vercel.com/docs/functions/configuring-functions/duration)、[waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)

## 実測と範囲

承認済みMac内native Supabaseで、実Postgres17.11・pg_cron1.6.4・pg_net0.20.4・REST・Storageと、実際のNext production buildのHTTPS入口を一続きに試験し、25項目成功。

1. 実接続12本でpermitを同時取得して1件のみ成功。
2. 実時刻の毎分CronとNext HTTP/private worker成功2回で受付が開いた。試験時刻の改変はしていない。
3. 実pg_netキューのURL／header／bodyに秘密・IDがないことを確認。
4. 同じownerの署名セッション→実APIアップロード→2枚受付。その後ブラウザのジョブ取得・resumeを一度も送らず、31秒×2枚が完了。合計40m・発注46m、通知受付1回。管理者利用枠0、既存IDは全て維持。
5. 実HTTP401をobserverが検出すると、古いhealthy記録があっても受付停止・枠消費0。その後の新しい実Cron/private成功2回で復帰。

OCRは31秒の合成SDK応答、LINEは本人役fixtureへの合成受付。実AI0・実LINE0。検証中の拡張ACL変更0。custom TLS Next serverとwaitUntil記録fixtureを使用しており、Vercel実配備のFunction寿命・実LINE到達・実iPhoneを検証したものではない。

最初の後始末で `cron.unschedule($1)` のoverloadにより定義が残った。stack停止後のbackup前検査で検出し、`cron.unschedule(jobid) ... where jobname=正確な試験名` に修正。残っていた1件を削除し、Cron定義0を別途検証した。停止済みstackのlocalhost宛てだけで、本番・外部送信への影響はない。harnessも削除件数を確認して報告するよう修正した。

SQLではprivate permit105項目、transport57項目が成功。広いnet権限を残した合成fixtureで401／403／429／503／redirect／TLS／timeout／観測／enqueue例外、偽の204、期限切れ・古い完了・再起動・warmup・権限を確認。transport試験の初期ハーネス不備を修正後、3回連続成功。実pg_netの各ネットワーク障害は旧候補のnative試験にも証跡があるが、新方式の全ケースをホスト環境で再試験済みとは扱わない。

## 端末保存・通知・方式の追加修正

- `GET /api/analysis-jobs` は署名された本人の未完・未保存結果・通知待ちを取得する。lastJobIdの端末保存が失敗しても再発見できる。結果の確認済み記録は、端末の下書き書込みと読戻しが成功した後にだけ送る。過去のterminal行は勝手に既存下書きを上書きしない扱いにし、元結果・IDは保持する。
- doneでも通知pending／failedなら監視とIDを残す。再開HTTP503や再送失敗でも終了しない。結果は先に使え、再読込後も通知を確認できる。画面からの再要求は30秒以上空け、待機中の再ポーリングで編集結果を上書きしない。閉画面でもCronが通知を再試行する。
- 受理時の方式をDB triggerで仕事ごとに保存する。表示はsessionの古いflagでなく、その仕事の方式と現在の稼働状態を使う。停止後に閉画面完了を誤表示しない。

これらはAPI単体、SQL9項目、ブラウザ12項目、実Next/REST 10項目で成功した。全単体63、型・lint・buildも成功。既存の実Postgres39＋206、通知28、provider51＋SDK33、権限99項目も通過した。最新結果は証跡のsummaryを参照。

## 費用と公開前の確認

Hobbyを維持し、Pro化や新しい有料環境は不要。毎分だと30日で43,200 HTTP起動、空の回でも概ね5 RPC／回＝216,000 DB API呼出しが追加される（Cron内部SQLは別）。HobbyのFunction Invocationsの含有枠は100万/月だが、既存分・CPU・メモリ・DB・AI・LINEも別に消費するため、実請求0や上限内を保証しない。[Hobby usage](https://vercel.com/docs/plans/hobby)

残る個別確認は、本番SESSION_SECRET 1個の生成・Production登録と、対象Supabaseのpg_cron有効化・毎分1件の固定URLへの空HTTP起動設定／公開wake入口の有効化。ディスパッチ鍵、Vault秘密、netのGRANT変更、bypass tokenは要求しない。実施するSQL雛形は [supabase-wake.example.sql](../ops/cron/supabase-wake.example.sql)。本番にはまだ適用していない。

本番バックアップ／復旧、実LINEと本人iPhoneでの閉画面確認、今回の差分の独立レビューを完了してから公開する。旧interactive版を先に公開しない。[公開手順](./production-release-readiness.md)、[保全計画](./production-backup-plan.md)
