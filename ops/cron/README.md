# 未有効化のバックグラウンド実行構成

このフォルダは構成の雛形です。**Cronはまだ有効化していません。** ルートに `vercel.json` は置かず、`ANALYSIS_BACKGROUND_MODE` の既定値を `disabled` にしています。現在のコードをそのまま公開しても、新規画像保存・ジョブ受付は503になり、処理できない仕事を受け付けません。

## 構成と確認できたこと

`DBの永続ジョブ → Vercel Cron（毎分）→ 認証付きGET /api/analysis-jobs/process → 期限付き画像リース → OCR → DB確定 → LINE`。

既存のDBキューとリースを使い、ブラウザが次の呼出し元になる必要をなくします。CronのHTTP要求は処理の終了と正常稼働記録を待ってから返ります。1回で終わらない仕事はDBに残り、次のCronが再取得します。既存の30秒開始予算は、一つの関数の実行制限に余裕を残すため維持します。

- 31秒かかる画像を2枚、画面から一度も再開要求を送らず、独立した定期呼出し2回で完了・通知1回になる回帰テストを追加。
- 6分リースで同じ画像の並行処理を防止。期限後に再取得し、古いワーカーの書込みは拒否。初回を含め最大3回。
- 稼働記録のない状態、1回だけの記録、停止・失敗状態では新規受付を拒否し、利用枠も消費しない。
- 30秒以上間隔のある2回以上の開始記録、2分以内の開始記録、6分以内の成功記録、直近エラーなしをDB時刻で確認する。
- `GET /api/analysis-jobs/worker-health` は読み取り専用。監視で呼んでも稼働記録を更新しない。Cronと同じ秘密が必要。
- `disabled` でのCronは稼働確認だけを行い、OCR・LINE処理は行わない。`scheduled` かつ正常な定期呼出しを確認して初めて受付可能。

Vercel Cronの配送はbest effortで、失敗時の即時再試行や全呼出しの到達を保証しません。DBの残仕事を次回も走査し、リースと冪等な確定で欠落・重複呼出しから回復する構成です。外部サービス停止中に完了時刻を保証するものではありません。停止を検知した場合は新規受付を閉じ、既存ジョブを残します。[Vercel Cronの配送・同時実行](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

## 費用と権限

- `* * * * *` の毎分実行はPro/Enterprise対応。Hobbyの最短は1日1回なので、この構成の受付条件・所要時間に対応しません。[公式の実行間隔](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- 確認時点のPro表示は **US$20/月**。既にProならCron自体の追加固定料金はなく、Functionsの利用量・料金が適用されます。現在のチーム契約は確認できていません。[Pro料金](https://vercel.com/pricing)、[Cron料金](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- 毎分だと30日で43,200回の起動。空の回でも開始記録・ジョブ照会・終了記録として概ね129,600回/月のDB RPCが増えます。仕事のある回には従来の画像解析・DB・LINE利用量が加わります。通貨・税・既存クレジット・実際の計算時間で請求は変わるため、確定請求額は算定していません。
- AI・Supabase・LINEは既存契約に従う。AI完了直後に関数が強制終了した場合、DBと外部AIを同一トランザクションにはできず、再推論の料金が重なる可能性は残ります。
- 現Vercelチーム情報の `GET /v2/teams/team_KOlFnguSk3s5yqYmQmvZCehz` は403（対象スコープ未認可）。チームへの継続アクセスの拡張はしていません。

必要な個別確認は、対象チームへのアクセス認可、現契約と必要ならプラン変更・継続費用、専用 `CRON_SECRET` と `SESSION_SECRET` の生成・設定、独立検証環境の資格情報です。実値の生成・登録・課金プラン変更は行っていません。

## 有効化手順（未実施）

1. 独立Supabaseと、LINEログインを検証できる独立Vercelプロジェクトを準備する。実際のCronはそのプロジェクトのproduction deploymentに対して検証する。通常のPreviewがCronを実行する前提にしない。[Cronの対象URL](https://vercel.com/docs/cron-jobs)
2. 新規構成にはPhase 1、画像リース、通知移行・稼働確認の3本のマイグレーションを順に適用する。旧Phase 1適用済みなら履歴を書き換えず、未適用の追加マイグレーションを適用する。別フォルダのPhase 2 SQLはこの時点で実行しない。
3. 承認された専用秘密を安全に設定する。秘密をコード・チャット・コマンド引数・ログに載せない。`ANALYSIS_BACKGROUND_MODE=disabled` を維持する。
4. 承認後に `vercel.scheduled.example.json` のcrons設定をルートのVercel設定へ統合し、独立プロジェクトへ配備する。既存設定がある場合は丸ごと置換しない。Cronの認証された実呼出しを2回以上確認する。この段階はOCR・LINEを動かさない。
5. 独立環境で署名認証・本人専用読取を確認した後、Phase 2 SQLを適用し、匿名権限の閉鎖・RLS・memoバケット非公開を検証する。その後 `ANALYSIS_BACKGROUND_MODE=scheduled` にし、再配備する。安全に読み込んだ環境変数 `SOKUPA_CHECK_ORIGIN` と `CRON_SECRET` で `node scripts/verification/check-worker-health.mjs` を実行し、200 / processing_ready:trueを確認する。これは稼働記録を更新しない。
6. 管理者・既存一般・招待履歴NULL・無制限・新規招待の実LINE認証、署名Cookie、画像保存、本人だけのジョブ取得、2〜5画像の解析、画面を閉じた後の継続、通知、再開・重複呼出しを確認する。iOS Safari/PWAでログイン中断・再読込・下書き復元を確認する。
7. Supabase実サービス経由の別接続による競合とワーカー強制終了を検証する。ローカルPostgres 17.6の20項目は通過したが、接続プール・Data API・Storageを含む実環境の確認には置き換えない。課金AIや実LINE送信の試験には、それぞれ許可された範囲のテストを用いる。
8. 本番のユーザー・招待・無制限・利用枠・ジョブ・画像行・通知メタデータ、スキーマ・関数・権限・RLS・Storage設定のバックアップを、アクセス制限した場所へ保存し、復元を検証する。IDと行数の比較基準を記録する。秘密をログに出さない。実バックアップはまだ取得していない。
9. 主要な互換性・安全性の確認が通ってから、本番へ承認済みの段階移行を行う。旧ワーカーを停止・drainし、旧コードが書込みを続けない状態を確認する。追加スキーマ、新クライアント、APIをdisabledで配備し、署名認証・ID・管理者・本人専用の読取経路と、想定どおりの受付停止を確認する。独立環境でAPI経路の全機能を確認済みであることを条件にPhase 2で公開書込みを閉じる。既存の公開書込み期間に改変された可能性があるユーザー・無制限一覧・未完ジョブは所有者が確認し、不明な仕事を自動処理対象に入れない。**公開ALLポリシーが残っている間はscheduledへ切り替えない。** Cronはdisabledの稼働確認を先に済ませ、権限閉鎖・データ確認・正常稼働の後にscheduledへ切替する。
10. 稼働確認は、読み取り専用のworker-health、認可失敗、ジョブ完了までの時間、古いqueued/running、failed/uncertain通知、管理者の無制限、匿名アクセス拒否、既存ID保持を確認する。主要ゲートが通らない場合は公開しない。

## 通知の移行とロールバック

`20261102193554_notification_upgrade_and_worker_health.sql` は、既に旧Phase 1が適用されていても既定値を明示的にlegacy_unknownへ戻す。過去の完了行で、安定したLINE再試行キーを使った証跡がないpending/failedはlegacy_unknownへ隔離する。送信済みか不明な通知を自動再送しない。変更前の値は `analysis_notification_migration_audit` に保持し、ユーザー・結果・IDは削除しない。

新しい作成RPCと新ワーカーはline_retry_v1を明示する。追跡済みの再試行・リース付き新処理は継続できる。ランタイム側も未知のプロトコルを送信しない。旧既定値に依存した将来の挿入も再通知対象に入れない。新規構成と旧Phase 1適用済みの両方を合成Postgresで検査した。

障害時は `ANALYSIS_BACKGROUND_MODE=disabled` とCronの停止／observeで新規受付・新しい解析を停止し、最大実行時間とリースが切れるまでdrainする。DBの追加カラム・関数・ジョブ・監査表は保持して、同じ認証・RLS・受付ゲートに対応する修正版を配備する。公開ALLポリシーへの復帰や、legacy_unknownを一括pendingへ戻す操作は行わない。必要な復元はバックアップと監査表を使い、通知の成否を個別確認して行う。

## ローカル検証

- Node回帰テスト50件、型・lint・本番ビルドを確認。
- 合成PGliteで権限・リース・稼働確認79項目、旧Phase 1／新規構成の通知アップグレード28項目を検査。
- 画面から独立した31秒×2枚の継続、HTTP応答が処理終了を待つこと、障害時の稼働不良記録、停止時の受付拒否をモックで確認。
- ローカル実Postgres 17.6でも、8接続の画像取得・確定・期限回復・利用枠競合・行ロックなど20項目が成功。TCPを使わず、私有Unixソケットと合成データだけを使い、終了後はDBを削除した。
- 実Cron・Supabase経由の複数接続競合・LINE実動作・iOS等を、この結果で検証済みとはしない。
- 正常な稼働記録だけでは受付を開かず、匿名／authenticatedの既存表権限閉鎖、対象表とStorageのRLS、memoバケット非公開も最低条件として確認する。これは実サービスでの匿名HTTP試験の代用ではない。

## 現在の公開ブロッカー

- Supabase接続先は本番sokupa一つ、開発ブランチ0件と確認。独立サービスでの移行・Storage・認証E2Eは未実施。
- 実LINE、iOS Safari/PWA、Supabase実サービス経由の複数接続競合は未確認。ローカルPostgres 17.6の別接続テスト20項目は通過。
- Vercelチーム情報は403。現プラン・必要な権限と専用Cron秘密の設定が未確認。
- Cronは未設定、モードは既定disabled。本番バックアップと復元実演もまだ実施していない。

公開の包括許可は受領済みだが、重大な互換性・安全性の確認という条件を満たしていないため、現時点では公開しない。個別確認が必要な資格情報生成・継続アクセス拡張・費用変更を先に実施しない。

ローカル実Postgresの再実行例（実サービスの資格情報は不要）:

```sh
PG_CLIENT_MODULE=/tmp/sokupa-pg-real/node_modules/pg PG_TEST_BIN=/tmp/sokupa-pg-real/node_modules/@embedded-postgres/darwin-arm64/native/bin node scripts/verification/postgres-concurrency.cjs
```

`PG_TEST_BIN` は利用環境のPostgres 17.6のbinディレクトリを指定する。上記はこの作業専用の一時インストール先。アプリのpackage.jsonとlockfileは変更していない。
