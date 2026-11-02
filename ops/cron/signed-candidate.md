# Hobby維持での署名付き定期実行候補

**外部へは未設定・未公開。追加固定費やプラン変更は行っていない。** ユーザーの「Hobbyのまま、商用の予定なし」という意向を採用し、ProアップグレードやVercel Cron毎分実行は選択しない。これはローカルの実装と隔離試験の成果であり、実Supabase Cronの稼働保証ではない。

## 実装した範囲

- `src/lib/scheduler-dispatch.ts` は専用HMAC-SHA256署名を検証する。固定HTTPS origin・GET・`/api/analysis-jobs/process`・呼出しUUID・発行時刻・開始期限を署名に含める。期限は最大120秒、未来の発行時刻の許容は15秒まで。同じ署名を管理操作やログインに使えない。
- `20261102210736_signed_scheduler_dispatches.sql` はサーバー専用の呼出しID表とclaim RPCだけを作る。期限をDB時刻でも検証し、同じIDは一度だけ使用可能。HTTP再送・並行実行による再利用は409で止め、二つ目のワーカーや成功記録を作らない。期限を過ぎた初回も拒否する。秘密・cron・権限拡張の設定は作らない。
- `supabase-dispatch.example.sql` は通常migration対象外の無効な雛形。非公開スキーマの設定は既定enabled=false。固定originと明示した専用Vault secret ID以外を受け付けず、秘密の実値は生成も設定もしない。enqueuer/reconcilerはDB運用主体だけが実行し、anon/authenticated/service_roleには権限を渡さない。HTTP側の専用鍵は処理APIだけの署名に使う。
- 分単位slotの一意性とロックで同じ分の二重登録を防ぐ。待機送信は最大8件。短いSQLでpg_netへ登録し、トランザクション終了後にHTTPを送る。HTTP timeout案は310秒、送信から応答を待つ期限は450秒。実拡張・実環境での検証はまだ必要。
- HMAC鍵はHTTPキューにもURLにも出さない。キューには有効期限と用途を限定した署名だけを置く。追跡表はUUID・slot・request ID・期限・状態・HTTP statusだけを保存し、署名ヘッダーや応答本文を複製しない。完了履歴の保持は1日。
- 別の短いreconcilerがrequest IDごとに応答を検査する。200、application/json、期待するprocessing_enabledとprocessed（0〜3）以外は成功にしない。HTMLログインページ、401、timeout、遅い応答、消失・無応答を分類する。SQLのenqueue成功や通信の成功からワーカーのheartbeatを作らない。
- 既存の成功2回・最新開始2分という受付条件は維持する。HTTPがワーカーまで到達しない場合、新しい成功記録はできず、古い記録が切れると受付が閉じる。通信観測だけで即座に受付を切る独立ゲートはまだ追加していない。

## 検証したことと未検証の境界

Node回帰は全59件成功。署名改ざん、別host/path/method、URL query、期限切れ、未来時刻、呼出し再利用を確認し、再利用時に新たなheartbeatを作らないことを確認した。

実ローカルPostgres 17.6で従来のコア並行試験39項目と、追加候補16項目が成功した。追加16項目では、標準pgcryptoの署名と独立したNode cryptoの照合、8接続のnonce一回性、8接続の同じ分のenqueue拒否、キーをHTTPへ渡さないこと、JSON応答・HTML・401・timeout・無応答期限、ロール拒否を確認した。

**この16項目のpg_net HTTP関数とVault復号ビューは合成fixtureであり、実拡張・実HTTP・実Vaultの検証ではない。** コアの39項目もSupabaseのData APIやVercelを通った試験ではない。実サービスに接続した試験と混同しない。

## 有効化前に残る条件

1. 独立した実pg_cron/pg_net環境が必要。現PATHにdockerはなく、CLI 2.90.0のstartはコンテナ方式。公式native方式のpg_cron修正はCLI 2.121.0以降と記載されているため、隔離した対応CLI／サービスを準備して実行するか、承認された独立Supabaseを使う。現行の共有CLIを無断で上書きしない。
2. 導入版pg_net 0.20.0はredirectを自動追跡する。短命・用途限定署名にしたが、301/302/307・TLS・DNS・キュー再起動での実送信は未試験。Vercelの保護がHTTPを先に止める場合はHMACを検証するアプリへ到達しない。広い保護バイパス秘密を自動生成・転送しない。別入口や保護設定の変更は個別確認する。
3. 独立環境で、実Cronの2回完了、31秒以上の画像2枚を閉じた画面で継続、DB異常終了・キュー消失・応答消失・期限切れ・二重呼出し・停止再開、匿名アクセス拒否を確認する。合成AI・LINEから始め、実API試験には別途許可された範囲を使う。
4. 専用鍵の生成・Vault／Vercelの安全な登録、正確なorigin、外部cron有効化は個別承認後。`ANALYSIS_DISPATCH_SECRET` / `ANALYSIS_DISPATCH_ORIGIN` は現状空。`ANALYSIS_BACKGROUND_MODE` はdisabledを維持する。
5. DB・Vercel実行・AI・LINEの利用量は残り、追加料金0や到達時刻は保証しない。Hobbyの利用条件への適合は利用者の予定を踏まえて確認し、商用と断定したり無断でProへ変更したりしない。

実有効化時もcron.scheduleは手動の承認対象とし、旧スケジューラと並行して登録しない。停止はまずアプリのdisabled、次にcron停止とdrain。既存ユーザーID・管理者無制限・招待制・非公開RLSを維持する。

公式資料と導入版の差は [supabase-feasibility.md](./supabase-feasibility.md) を参照。初期調査から進み、上記のローカル実装・試験までは完了したが、外部設定と実拡張試験は未完了。
