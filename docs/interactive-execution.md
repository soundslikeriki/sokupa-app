# 既存の操作を保つ段階公開案

2026-11-03。Hobbyを維持し、定期実行の導入を今回の安全修正と切り離すための実装。本番は変更していない。ユーザーの「今までのように使える」を優先し、署名付きセッション、招待、既存LINE ID、管理者無制限、画像解析、編集、発注、完了通知を維持する。専用の端末IDを作り直す処理はない。旧ログインは署名がないため、一度だけ同じLINEで再ログインする必要がある。端末の下書きは削除しない。

## 選べる実行方式

| 項目 | interactive（今回の段階公開候補） | scheduled（将来の別段階） |
| --- | --- | --- |
| 呼出し元 | 受付時のwaitUntil＋本人の画面からの再開 | 正常性を確認した定期実行＋画面からの再開 |
| 画面を開いている間 | 複数枚を順に処理・表示、最後に通知 | 同左 |
| 画面を閉じた後 | 実行中の処理はFunction寿命内で継続。次の画像／リトライが待機する場合がある | 定期実行が正常なら次回呼出しで再開 |
| 再開 | 同じLINE IDで画面を開き直す。6分の生存リースは待つ | 期限付きリース＋次回定期実行 |
| 追加の秘密 | SESSION_SECRETのみ | セッション秘密に加え、採用方式の専用資格／設定 |
| pg_net・Vaultの管理権限 | 不要。拡張の権限を変更しない | 旧署名候補には未解決の管理権限条件あり |
| 費用 | 新しい固定課金・常時毎分呼出しなし。従来のAI／DB／LINE等の利用量は継続 | 起動・照会の利用量と運用が追加 |

閉じたまま必ず全画像が完了する保証はinteractiveにはない。例えば31秒×2画像では、1枚目の後で次の呼出しを待ち、開き直すと2枚目が処理される。これは試験で明示確認した制約であり、「スマホを閉じても完了通知」と案内しない。既存版よりバックグラウンド継続が保証されるとは説明しない。

実行中のFunctionも強制終了・通信障害・外部AIの遅延を受ける。`maxDuration=300` はFluid Compute時のHobby上限内だが、対象プロジェクトの `resourceConfig.fluid=true` は既存認証のread-only CLI APIで確認した。実際の配備への300秒設定反映・寿命は未試験。ローカルAPI試験のwaitUntil保持は、Vercel実環境の継続保証の証拠にはならない。[Function duration](https://vercel.com/docs/functions/configuring-functions/duration)、[waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)

## 受付の安全条件

新しいmigration `20261103070253_interactive_execution_policy.sql` は実行方式を管理用の非公開表に記録する。既定はscheduledのまま、アプリ環境変数の既定はdisabled。適用しただけでは受付は開かない。

- アプリの `ANALYSIS_BACKGROUND_MODE` とDBの方式が一致することが必要。service_role・匿名ユーザーは方式を変更できない。
- interactiveでもPhase 2の非公開DB／Storageとprovider稼働条件は必須。公開ALLを残したまま使う経路は作らない。障害時は予約前に拒否する。
- scheduledの成功2回・世代・期限・通信障害の判定はそのまま。interactiveへ変更して稼働成功記録を偽造しない。方式変更時は古い稼働世代を破棄する。
- DB側の作成RPCにも条件があり、APIの事前確認だけには依存しない。利用枠の予約・返却、一般20枚/月、管理者／無制限の枠免除を維持する。
- 所有者確認、画像リースと確定トークン、安定した通知再試行キーを共有する。閉じた間の仕事を新しい仕事として作り直さない。

## 実測した確認

`scripts/verification/interactive-policy.cjs`: PGliteで40項目成功。公開状態での有効化拒否、mode不一致、provider停止、利用枠、NULL招待履歴、admin無制限、権限、scheduledの再確認を検査。

`scripts/verification/live-local-interactive.cjs`: 承認済みMac内Supabase native stackで26項目成功。実Postgres17.11／REST／Storage、実SDK、実際のNext API関数・ジョブ処理を使用。OCRを31秒の合成応答、LINEを合成受付に置換し、それ以外の外部宛て通信を拒否した。

1. 実セッション検査→本人専用アップロード→ジョブ作成→31秒画像→完了→通知状態の保存。
2. 2枚処理を画面から再開しない場合は1枚完了で待機し、他人の読取・再開は404。
3. 本人から3つ同時の再開要求で、2枚目のAI呼出しは1回。合計40m・発注46m、完了通知は各ジョブ1回。完了後の再開でも再通知しない。
4. 既存のユーザーIDと招待履歴NULLを保持、管理者枠0、Cron0、擬似heartbeat0、明示停止は503。

実AI呼出し0・実LINE送信0。実HTTP経由のNext入口、OAuth往復、VercelのFunction寿命、実iPhoneはこの試験では確認していない。最初の検証で停止設定テストに不正な画像パスを渡して400となったため、有効な既存パスへ修正して全26項目を再実行した。実装の停止機能の故障とは扱わない。

Chromeの合成API試験は既存9項目＋独立レビューとinteractive案内13項目が成功。保存復元・負数拒否、interactive案内の表示と、閉じても完了するという文言が出ないことを確認した。

回帰検証は単体61、権限95、通知移行28、provider回復51＋SDK/worker33、transport109、実Postgresコア39＋scheduler/crypto206項目が成功。型・lint・buildも成功。libheifの動的requireとBrowserslistの既存警告は残る。

## 公開の最小手順

詳細は [production-release-readiness.md](./production-release-readiness.md)。公開の包括許可は既にある。追加の個別承認対象は、まず32バイト以上の本番専用SESSION_SECRET 1個の生成・Vercel Productionへの登録。Cron秘密・Vault・拡張ACL変更・Pro化はこの段階には不要。既存LINE／Supabase／AI／admin値は維持する。

本番DB／Storageのバックアップと確認、既存仕事のdrain、追加migration8本、新APIへの切替、Phase 2、認証・ID・本人専用アクセスの確認を一つの切替作業として行う。その後、rootで `select public.set_analysis_execution_mode('interactive');`、アプリのmodeをinteractiveにして有効化する。両方が一致するまで正常利用できたとは報告しない。一般のアプリ利用者からこのSQLは実行できない。

実LINE／iPhoneの最低限の本人確認を行える手順と復旧が揃うまで公開しない。実画像をAIへ送り、エージェントからLINE通知する試験には、宛先・枚数・費用範囲の確認が別途必要。本人が自らiPhoneで使用する場合も、受付後に画面を閉じた時の制約を説明する。

将来の全画像自動継続は別リリースとし、[秘密を載せない起動通知案](../ops/cron/secret-free-wake-design.md)は未実装・未承認。これを今回の受付条件にはしない。
