# 既存URLへ公開するための最短の安全な手順

ユーザー最新方針は「問題なさそうなら、テスト用URLを必須にせず公開する」。公開の包括許可は受領済み。以下は2026-11-03の読取確認と準備結果であり、本番へ変更・配備・秘密生成はしていない。

## 現在の本番と接続

- Vercel: `sokupa-app` / `prj_9cgKHuUfIbFQ2pctK35y3AOqFBbx`、チーム `team_KOlFnguSk3s5yqYmQmvZCehz`。現本番deployment `dpl_AZDxpxoziaJP68E7vWJtPNuS7u4V` はREADY、コミット `919379d9e45e367a45d3b6f64b01724a528fe3f2`。作業版はまだ配備していない。
- `https://sokupa-app.vercel.app/` の認証なしHEADは200、redirectなし。生成deployment URLのルートは302でVercel SSOへ転送された。解析・LINE・動的な処理APIは呼んでいない。処理APIの実到達性を確認済みとはしない。
- Vercel Authenticationは `all_except_custom_domains`、パスワード保護／Trusted IPsは無効。保護設定の変更、共有リンク、bypass秘密の生成は不要なまま維持する。[Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- Vercel CLI 51.1.0に既存認証があり、whoami成功を値非表示で確認。`deploy --prod --skip-domain` の引数が使えることもhelpで確認した。ログインを新規開始したり、tokenを生成したりしていない。
- 環境変数は `decrypt=false` のメタデータだけ確認。LINE／Supabase／AIの既存値を取得していない。`SESSION_SECRET`、`ANALYSIS_DISPATCH_SECRET`、`ANALYSIS_DISPATCH_ORIGIN`、`ANALYSIS_BACKGROUND_MODE` は未登録。
- 本番キーの多くがPreviewにも同じ環境変数レコードとして割り当てられている。現在の設定のままPreviewへ配備して本番から分離できたとは扱わない。ユーザーの最新方針どおり、別Preview URLを必須にはしない。

## 先に解消する点

| 対象 | 具体的な不足 | 必要な最小の操作 |
| --- | --- | --- |
| 署名セッション | `SESSION_SECRET` 未登録。現状で新コードを公開すると安全なログインを発行できない | 32バイト以上の専用値を生成し、Vercel ProductionのSecretへ登録する個別承認。既存LINE ID／admin値は変えない |
| 定期処理の署名 | `ANALYSIS_DISPATCH_SECRET` 未登録 | 別の32バイト以上の専用値を生成し、Vercel Productionと対象Supabase Vaultへ同じ値を安全登録する個別承認。セッション鍵・LINE tokenを流用しない |
| 定期処理の権限 | 本番net／Vault表の所有者はsupabase_admin。現在の接続はpostgresで、所有者のmemberではなく、net表・schemaのGRANT OPTIONもない。anon等にはnet表のSQL権限が残る | 現候補の厳しい権限ガードを満たす変更経路が未解決。Supabaseの正式な運用手段を確認するか、現有権限のままAPI非公開等を安全に検証する別設計をレビューする。ユーザーへsupabase_adminの秘密を求めない |
| 本番バックアップ | 実本番のDB／Storageバックアップ未取得。Webダッシュボードへのログインだけではpg_dump用のDB接続にはならない | Connectで既存接続情報を安全に用意する。パスワードをチャットへ貼らない。未保持ならresetを無断実行しない。接続後は読取バックアップ・内容検査から行う |
| 実動作 | 実LINE Login／通知到達とiOS/PWAは未確認 | 公開切替の中で本人の再ログイン・admin無制限・下書き・画像処理を確認。エージェントが課金AI／実LINE送信を試す場合は画像枚数・宛先・通知回数・費用範囲を個別確認する |

上の権限問題はダッシュボードへのログインや、公開許可をもう一度もらうだけでは解決しない。ローカルではsupabase_adminを使えたが、ホスト版で同じ権限を利用できるとは限らない。本番ではメタデータを読んだだけで、REVOKE／SET ROLE／DDLを試していない。

なお、SQLロールにnet権限があることだけで匿名HTTP経由の読取が可能と断定しない。ローカルではnetのData API指定は406だった。現候補の条件を満たさないという事実と、実際のHTTP公開範囲は区別して判断する。ガードを黙って弱めて公開しない。

## バックアップと復旧の準備

`scripts/verification/local-backup-restore.cjs` で、承認済みの使い捨てnative stackの合成publicスキーマを実pg_dumpし、同clusterの新しい別DBに実pg_restoreした。15表の全行／ID／通知状態、ACLとRLSが一致し、10項目成功。一時の復元DBは削除し、stackも停止した。新しい資格情報は生成していない。

この予行は合成publicスキーマだけで、本番バックアップ、Storage実ファイル、Auth／Vaultの移植を検証したものではない。Freeプロジェクトでは手動exportを用意し、DBバックアップだけでStorageファイルも復元できるとは扱わない。[Database Backups](https://supabase.com/docs/guides/platform/backups)

本番では接続設定を保護したファイル／標準入力から読み、URL・passwordをコマンド引数やログへ載せない。IPv6が使えない場合はConnectのSession poolerを利用し、IPv4有料add-onを無断で追加しない。DBパスワードの再設定も未実施。[公式バックアップ手順](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

バックアップ対象はアプリのユーザー・招待・無制限・利用枠・ジョブ・画像行・通知監査、必要なschema／関数／権限／RLS、Storage設定と実ファイル、適用済みmigration履歴。IDと既存NULL招待履歴を保持し、所有者が既存ユーザー／無制限一覧を確認する。バックアップの保存先はアクセス制限し、hash・件数・復元手順を記録する。

## 条件が揃った後の切替順

1. 権限方式の解決・独立レビュー完了、必要な専用秘密の承認と設定、本番バックアップの検査を先に行う。Hobbyを維持し、Pro化や有料環境作成は行わない。
2. 管理者が既存の解析を止めた状態で、追加schema7本を順番に適用し、対応する新APIをdisabledで配備する。`--prod --skip-domain` なら本番設定でbuildしても、既存の公開ドメインは自動切替しない。新規資格情報の設定前に配備しない。
3. reviewed commitと対象project／teamを照合して、段階的な切替を行う。公開ドメインを新しい署名APIへ切り替えて旧版の新規受付を止め、旧300秒処理が終わるまで6分以上drainする。旧版を公開したまま新旧workerを並行稼働させない。関連aliasも確認する。
4. 本人のLINE再ログイン、同じID、admin無制限、招待履歴NULLの既存ユーザーの互換性を確認。旧端末の下書きを削除しない。LINEチャネルと既存callbackは保持する。callback追加や変更が必要なら個別確認する。[LINE callback仕様](https://developers.line.biz/en/docs/line-login/integrate-line-login/)
5. API経路へ切替済み・旧worker終了を条件にPhase 2で匿名DB／Storageアクセスを閉じる。ownerの読取と匿名拒否を検査する。公開ALLを残したまま処理を有効化しない。
6. 解決・承認済みのschedulerをdisabledの稼働確認から開始する。固定originは生成URLではなく `https://sokupa-app.vercel.app` を使う案。実入口のredirectとJSON／nonce／worker証明を検査する。広いVercel bypass秘密を渡さない。
7. modeと期待する応答をscheduledへ合わせ、新世代の実呼出し2件を確認してから画像受付を開く。本人のiPhone Safariでログイン・写真選択・結果編集・保存／復元・画面を閉じた処理・通知を確認する。PWAはSafariのホーム画面追加から別の保存領域・再ログインも確認する。

解析受付が一時停止する切替になる。完了時刻はホスト権限方式の解決に依存するため、現時点で「すぐ公開可能」とは報告しない。

## 障害時

新規受付disabled、scheduler停止、drainを先に行う。旧919379d9の匿名DB版にそのまま戻したり、公開ALLを復活させたりしない。署名セッションとRLSを維持する修正版へ戻す／進める。データ復元が必要な場合はバックアップと通知監査を使い、旧通知を一括pendingへ戻さず、送信済みか不明な通知を再送しない。

ユーザーの次の最小確認は、方式が確定した後の「専用秘密2個の生成・本番登録」と「既存DB接続を安全に使う準備」。公開許可・Vercel接続・Macローカル環境起動の許可は再度求めない。
