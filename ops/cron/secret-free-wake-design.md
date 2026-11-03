# 秘密を載せない起動通知の検討（未実装）

2026-11-03。hosted Supabaseの拡張表の所有権を変更できない前提で、将来のclosed-screen継続の候補を検討した。これは採用済みの認証方式・安全性検証済みの実装ではない。現在の段階公開は [interactive方式](../../docs/interactive-execution.md) を用い、下記の外部設定を有効にしない。

## 制約を受け入れる

Supabaseは、pg_netに送るURL／header／bodyがDB接続ロールから読まれること、Vaultから読み出した秘密もheaderに平文で残ること、net表の個別プロジェクト向けgrant／RLS変更をサポートしないことを明記している。旧候補のprivate extension ACLガードを単に外すことはしない。短命HMACでも有効期間内のcredential漏えいと先取り・妨害が残る。[公式制約](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net)

## 候補の仕組み

1. rootのCronだけが、非公開のアプリ表へ毎分1件以下の期限付き実行許可を作る。slotの一意制約とDB時刻を使い、一般ロールは作成・読取・変更できない。
2. pg_netは固定の公開wake URLだけへ送信する。認証header、署名、permit ID、job ID、LINE ID、結果やその他の秘密をURL／body／応答へ載せない。pg_netのHTTP送信自体は公式機能だが、この認可設計全体がSupabaseに承認されたわけではない。[pg_net API](https://supabase.github.io/pg_net/api/)
3. Vercelが既存のサーバー資格でDBへ接続し、未使用で期限内の実行許可を一つだけ原子的に取得する。HTTPの送り手は信用しない。許可がなければ処理を始めず、公開応答は常に情報を持たない固定値とする。
4. 取得後の処理をwaitUntilへ登録し、HTTP応答から切り離す。実行中リース・確定トークン・通知キーは維持する。FunctionのタイムアウトでwaitUntilも終了するため、次の許可で期限切れリースを回復する必要がある。[waitUntilの制約](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)
5. 稼働証明はprivate DBに書かれた正当な取得と完了だけとする。公開pg_net応答の200／204は成功の根拠にしない。通信失敗・期限超過は受付を閉じる側にだけ作用させる。障害後は独立したprivate完了2回と世代・時刻検査を取り直す。

外部の第三者がwakeを叩いても、rootが既に許可した仕事を早く起動できるだけに制限する設計。ただし公開入口への大量要求によるFunction・DB RPCの消費と、正規仕事の開始タイミングへの干渉は残る。秘密がないことを認証済みと同義にしない。無料で強いレート制限が使えると断定しない。

## 実装前に必要な検証と判断

- 競合100要求でpermit1回、再送／期限前後／停止再開／クラッシュ回復、古い完了の拒否。
- net表を読める・書けるロールがURLを変えても機密を奪えず、公開応答を偽造してもhealthyにならないこと。
- 正常HTTPだけで稼働を判定せず、301／302／401／TLS／遅延／応答削除でも受付が安全に停止し、private成功2回で復帰すること。
- Vercel実入口のredirect、実Function寿命、waitUntil動作、DoS耐性、Hobby上限と監視。Hobbyの業務用途規約への適合は本人だけの使用という事実だけで断定しない。
- 毎分43,200回/月のHTTPと複数DB RPCが追加される。追加固定プランを要求しない構成は可能だが、既存枠を超えないことや実課金0円は未保証。
- 個別承認が必要な本番Cron設定・公開入口追加・継続アクセス条件。資格情報はネットワークへ渡さずとも、権限と運用が変わる。

この候補は実装・隔離試験・独立レビューが未完了であり、既存の安全確認済みsigned候補をそのまま置換できるとは報告しない。今回はこれを理由にinteractive版の準備を止めない。
