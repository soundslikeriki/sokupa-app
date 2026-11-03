# Hobby維持での署名付き定期実行候補

**外部へは未設定・未公開。追加固定費やプラン変更は行っていない。** ユーザーの「Hobbyのまま、商用の予定なし」という意向を採用し、ProアップグレードやVercel Cron毎分実行は選択しない。これはローカルの実装と隔離試験の成果であり、実Supabase Cronの稼働保証ではない。

追補: Mac内の実native Supabase起動と試験用資格情報作成が個別承認され、実Cron／pg_net／Vault／REST／Storageで主試験43項目が成功した。最新結果と未完了の450秒期限観測は [実検証の記録](../../docs/local-supabase-validation.md) を参照。以下の未検証記述・項目数はその前の段階の記録。今回、明示ポート、拡張権限検査、request ID再利用への対応を候補に追加し、Nodeは60件、Postgres候補SQLは205項目が成功している。

## 実装した範囲

- `src/lib/scheduler-dispatch.ts` は専用HMAC-SHA256署名を検証する。固定HTTPS origin・GET・`/api/analysis-jobs/process`・呼出しUUID・発行時刻・開始期限を署名に含める。期限は最大120秒、未来の発行時刻の許容は15秒まで。同じ署名を管理操作やログインに使えない。
- `20261102210736_signed_scheduler_dispatches.sql` はサーバー専用の呼出しID表とclaim RPCだけを作る。期限をDB時刻でも検証し、同じIDは一度だけ使用可能。HTTP再送・並行実行による再利用は409で止め、二つ目のワーカーや成功記録を作らない。期限を過ぎた初回も拒否する。秘密・cron・権限拡張の設定は作らない。
- `supabase-dispatch.example.sql` は通常migration対象外の無効な雛形。非公開スキーマの設定は既定enabled=false。固定originと明示した専用Vault secret ID以外を受け付けず、秘密の実値は生成も設定もしない。enqueuer/reconcilerはDB運用主体だけが実行し、anon/authenticated/service_roleには権限を渡さない。HTTP側の専用鍵は処理APIだけの署名に使う。
- 分単位slotの一意性とロックで同じ分の二重登録を防ぐ。待機送信は最大8件。短いSQLでpg_netへ登録し、トランザクション終了後にHTTPを送る。HTTP timeout案は310秒、送信から応答を待つ期限は450秒。実拡張・実環境での検証はまだ必要。
- HMAC鍵はHTTPキューにもURLにも出さない。キューには有効期限と用途を限定した署名だけを置く。追跡表はUUID・slot・request ID・期限・状態・HTTP statusだけを保存し、署名ヘッダーや応答本文を複製しない。完了履歴の保持は1日。
- 別の短いreconcilerがrequest IDごとに応答を検査する。200、application/json、期待するprocessing_enabledとprocessed（0〜3）に加え、呼出しUUIDと、そのUUIDに紐付いた実ワーカーの成功完了IDが必要。JSONだけを返す転送先は成功にならない。SQLのenqueue成功や通信の成功からワーカーのheartbeatを作らない。
- 追加migration `20261102213147_scheduler_transport_health.sql` に独立した受付ゲートを追加した。401/403/5xx、TLS・timeout、最終3xx、HTML／不正JSON、応答期限超過、enqueue／観測処理の異常を観測したトランザクションが確定すると受付を閉じる。以前のheartbeatが新しくても画像保存・ジョブ作成・再開を拒否し、作成RPCも枠の予約前に拒否する。実HTTP到着から次の毎分観測までの遅れは残り、無応答は450秒の期限または成功記録の失効で止まる。
- 復帰は障害後の新しい世代で、30秒以上離れた別UUIDの署名付き呼出し2件が実ワーカーで成功し、HTTP応答も確認できることが必要。最新enqueue／成功開始2分、前の成功開始3分、確認6分以内という鮮度条件を加える。古い完了、再送、無関係な空のheartbeat、失敗前に始めた呼出しでは復帰しない。2分超のenqueue停止・設定変更・停止再開でも取り直す。
- `pg_net 0.20.0` の `net._http_response.created` はHTTP完了時刻ではなく、HTTPバッチより前に開始したDBトランザクションの時刻になり得る。確認時点の `clock_timestamp()` と450秒の期限を使い、呼出しに紐付いたDBの実成功完了を照合する。期限を過ぎて観測した正常応答も安全側で拒否する。[0.20.0ワーカー実装](https://github.com/supabase/pg_net/blob/v0.20.0/src/worker.c)、[応答表の既定値](https://github.com/supabase/pg_net/blob/v0.20.0/sql/pg_net.sql)
- transport表はRLS付きでservice_roleは読取のみ。世代変更・応答記録・設定はDB運用主体のみ。署名ワーカーだけがnonceと実tickを結ぶRPCを使う。未選択のtransportは既存の別schedulerを妨げないが、一度有効にしたtransportの停止は受付を閉じる。

## 検証したことと未検証の境界

Node回帰は全59件成功。署名改ざん、別host/path/method、URL query、期限切れ、未来時刻、呼出し再利用を確認し、再利用時に新たなheartbeatを作らないことを確認した。

実ローカルPostgres 17.6でコア並行試験39項目と、候補183項目が成功した。標準pgcryptoとNode cryptoの照合、8接続のnonce・slot・応答の一回性、401等の障害後の受付停止、利用枠予約前の拒否、失敗と古い成功の競合、2回の正常復帰、観測／鍵参照エラー、pg_netのバッチ時刻と遅い観測、ロール拒否を確認した。183には各障害前の正常化確認を含む。

PGliteではtransport受付・復帰と旧候補有効化済み環境からの移行を109項目確認した。**183項目のpg_net HTTP関数とVault復号ビューは合成fixtureであり、実拡張・実HTTP・実Vaultの検証ではない。** コア39項目もSupabaseのData APIやVercelを通った試験ではない。

## 有効化前に残る条件

1. 独立した実pg_cron/pg_net/Vault環境が必要。最小手順・必要権限・費用・確認対象は [isolated-pgnet-runbook.md](./isolated-pgnet-runbook.md) に記載した。現行の共有CLIを無断で上書きしない。
2. 導入版pg_net 0.20.0はredirectを自動追跡し、最終結果から転送経路全体は検出できない。最終3xx・ログインHTML・無効なJSONは拒否するが、全redirectの拒否やヘッダー転送防止を実証したとは扱わない。301/302/307・TLS・DNS・キュー再起動での実送信は未試験。Vercelの保護が先に止める場合はアプリへ到達しない。広い保護バイパス秘密は生成・転送していない。必要ならredirectを拒否する中継・専用入口を別途検証し、外部設定と費用は個別確認する。
3. 独立環境で、実Cronの2回完了、31秒以上の画像2枚を閉じた画面で継続、DB異常終了・キュー消失・応答消失・期限切れ・二重呼出し・停止再開、匿名アクセス拒否を確認する。合成AI・LINEから始め、実API試験には別途許可された範囲を使う。
4. 専用鍵の生成・Vault／Vercelの安全な登録、正確なorigin、外部cron有効化は個別承認後。`ANALYSIS_DISPATCH_SECRET` / `ANALYSIS_DISPATCH_ORIGIN` は現状空。`ANALYSIS_BACKGROUND_MODE` はdisabledを維持する。
5. DB・Vercel実行・AI・LINEの利用量は残り、追加料金0や到達時刻は保証しない。Hobbyの利用条件への適合は利用者の予定を踏まえて確認し、商用と断定したり無断でProへ変更したりしない。

実有効化時もcron.scheduleは手動の承認対象とし、旧スケジューラと並行して登録しない。停止はまずアプリのdisabled、次にcron停止とdrain。既存ユーザーID・管理者無制限・招待制・非公開RLSを維持する。

旧雛形を既に適用した確認環境では、新しいpublic migrationを先に適用すると受付が閉じる。続いて更新雛形を再適用する。IF NOT EXISTS／CREATE OR REPLACEで設定のorigin・secret IDは保持するが、過去の成功は破棄し、新しい正常応答2回を要求する。新規／旧版の両経路を検査した。本番にはどの版も未適用。

公式資料と導入版の差は [supabase-feasibility.md](./supabase-feasibility.md) を参照。初期調査から進み、上記のローカル実装・試験までは完了したが、外部設定と実拡張試験は未完了。
