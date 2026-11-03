# 秘密を載せない起動通知

最新要件に合わせて実装・Mac内隔離試験を完了した。本番は未適用・外部設定の個別確認待ち。開き直し依存のinteractive版は公開対象から外した。

[設計・セキュリティ・費用・実測・限界](../../docs/closed-screen-execution.md)、[未有効化の運用SQL](./supabase-wake.example.sql)、[本番手順](../../docs/production-release-readiness.md)を参照。

pg_netは固定URLと空のJSONだけを送る。鍵・署名・permit ID・ユーザー情報は載せない。private DBのroot発行許可をサーバーだけが取得する。HTTP204を成功証拠とせず、private worker完了2回と世代／期限／実開始間隔で受付を判定する。netのgrant変更・Vault・新しいdispatch秘密は不要。公開入口への大量要求によるFunction／DB RPC消費は残り、独立レビューと利用量監視が必要。

Supabaseの正式機能であるCron／pg_netとVercel waitUntilを利用した独自の認可設計であり、設計全体が各社に承認されたと主張しない。[公式pg_net制約](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)、[waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)
