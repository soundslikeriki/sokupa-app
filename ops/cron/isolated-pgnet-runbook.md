# 実pg_net／Vaultの隔離確認に必要な最小手順

2026-11-02調査。**以下は未実行の手順。** 現在の確認済み範囲は実PostgresのSQL／pgcryptoまでで、HTTP関数とVaultビューは合成fixture。クラウドの設定変更・鍵生成・課金変更はしていない。Vercel Hobbyを維持する。

## 先に必要な最小の選択

第一候補は、この作業専用のローカルSupabase。クラウドのプロジェクト作成・継続アクセス拡張が不要で、Supabase／Vercelのホスティング料金を発生させず実拡張を試せる。現Macはarm64、macOS 26.6.2なので公式native対応範囲に入る。ただし現在のCLI 2.90.0はnative非対応、PATHにdockerもない。対応CLIの隔離配置、サービスのダウンロード・起動、試験専用のローカル設定と資格情報の準備が必要。これらはまだ実施していない。

公式のnative stackは実験的。pg_cronを試す場合は2.121.0以降で版を固定し、その版のhelpで引数を確認する。共有CLI・既存stack・ホームの設定は上書きしない。[公式runtime仕様](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)

追補: 公式CLI 2.121.0単体の隔離配置とchecksum検証は完了した。`--version`、`start --help`、`stack --help`、`stack prepare --help` が成功し、native／専用stack／eagerの引数を確認した。共有2.90.0は未変更。サービスは起動しておらず、アプリ／DBの資格情報は生成していない。CLI自身の一時キャッシュは隔離したSUPABASE_HOME内にある。`stack prepare` はダウンロードだけでなくstackを作成・登録するため、まだ実行していない。追加の自動生成設定・資格情報の有無を確認してから進める。

| 対象 | 必要な権限／判断 | 現在の状態 |
| --- | --- | --- |
| このMacの作業専用一時ディレクトリ | サービスのダウンロード、localhostへのbind、非rootプロセス起動、試験後の停止・削除。共有ソフト／OS利用者は変更しない | CLI単体とhelp確認は完了。stack設定・資格情報準備／起動は個別確認待ち、未実行 |
| ローカルの使い捨てDB | DB運用者としてpg_cron／pg_net／pgcrypto／supabase_vaultの導入・設定、合成行・試験専用Vault値、cronの登録と削除 | 実拡張は未導入。実行済みのSQLハーネスとは別 |
| 独立Supabaseを使う場合 | 対象組織の選択、Free残枠・見積、プロジェクト作成権限、対象DBの運用権限 | 本番しか接続されていない。新規作成・新しい資格情報は未承認／未実行 |
| 実Vercelへの到達試験 | 検証専用origin／deploymentと環境変数の設定。専用HMAC鍵をVaultと対応環境へ登録する個別確認 | チーム接続承認は済み。これは鍵生成や保護解除の承認には含めない |

## ローカルで行う順序

1. 許可後、専用ディレクトリにCLIを固定する。`SUPABASE_HOME` もその配下にして既存のホームを使わず、`SUPABASE_EXPERIMENTAL_STACK=1` と専用stack名を使う。`stack --help`／`start --help` を確認し、`--runtime native` を明示する。`--eager` で検証中の遅延起動を避ける。CLIが接続URL／鍵を出力するため、標準出力は0600の一時ファイルに保存し、チャットへ出さない。localhostにだけ公開されていることをOS側でも検査し、外部公開なら停止する。[stackの分離と引数](https://supabase.com/docs/guides/local-development/running-multiple-local-projects)
2. **リンクも本番スキーマのpullも行わない。** `pg_extension`、`pg_available_extensions`、pg_net workerとcron設定を確認する。実拡張がサービスの配布物に含まれない場合は、合成関数で置き換えて実試験と呼ばず、そこで停止して必要な配布物を報告する。DB運用者が拡張を有効化する。pg_net／pg_cronはバックグラウンドワーカーの起動が必要で、stock PostgreSQLへのSQLだけでは足りない。[Cron導入](https://supabase.com/docs/guides/cron/install)、[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
3. まず実pg_netからlocalhostの合成HTTPサーバーに到達させ、実Vaultには既知の試験専用値だけを保存・取得する。秘密全文をSELECTで出力しない。アプリ／匿名ロールへVault復号ビューやnetのキュー／応答表の読取・書込権限を広げない。上流pg_netのSQLにはPUBLICへの広い既定GRANTがあるため、**実際の権限を必ず検査する**。隔離DBに限って試験に必要な運用権限へ絞る。本番の共有net権限は別途利用箇所を調べず変更しない。[Vault](https://supabase.com/docs/guides/database/vault)、[pg_net 0.20.0のGRANT](https://github.com/supabase/pg_net/blob/v0.20.0/sql/pg_net.sql)
4. SQLハーネスのアプリ表定義を基に合成スキーマを準備する。実stackの既存ロール／storage等を上書きせず、ハーネスのnet／Vaultモックは作らない。7本の追加migrationを順番に適用し、手動Phase 2 SQLもこの隔離DBだけに適用する。次に `supabase-dispatch.example.sql` を適用する。enabled=falseなので送信は始まらない。既存版からの経路では追加migration→更新雛形の順にし、ID／設定を保持したまま受付が閉じることを確認する。
5. 完全な署名経路は固定**HTTPS** originを要求する。localhostのHTTPだけを通して候補のTLSを検証済みにしない。試験専用の信頼されたTLS入口か、承認済みの独立HTTPS deploymentが必要。証明書／専用鍵生成・外部入口・保護設定は個別確認対象。検証中はAIとLINEの送信先を合成サーバーに固定し、実サービスへの呼出しを禁止する。
6. 検証専用のoriginとVault secret IDを設定してからenabled=trueにする。`ANALYSIS_BACKGROUND_MODE=disabled` のまま実署名HTTPを2回完了させる。cronはDB運用主体から1分に一度、**reconcileしてからenqueue**する短いSQLを一つだけ登録する。cron本体にBEGIN／COMMIT、URL、ヘッダー、鍵を書かない。HTTPはトランザクションcommit後に動くため、DB内で応答を待たない。cron名／job IDと削除手順を記録する。[Cronの実行モデル](https://supabase.com/docs/guides/cron)
7. 下表を実拡張・実HTTPで通し、合成データとHTTP観測の結果だけを残す。終了後は試験cronを削除し、専用stackを停止・破棄する。既存stackを対象とする `--all` 操作は使わない。データ／設定／接続ファイル／試験鍵の残置を確認する。

## 実拡張で必要な合格条件

| 試験 | 合格条件 |
| --- | --- |
| 2回の正常完了・処理切替 | 別UUID、実ワーカー成功、応答の一致を確認。scheduledへの切替前は処理をしない。切替後も適切な2回の確認が必要 |
| 401/403/429/5xx、TLS／DNS／切断、HTML／不正JSON | 観測した障害で新規受付が閉じ、枠が増えない。修復後は新しい2回が必要。古い／重複した完了で復帰しない |
| 期限・クラッシュ | 無応答、450秒超、unloggedキュー／応答消失、DB／pg_net再起動後に安全に停止・復帰する。pg_net.createdが完了より前でも誤判定しない |
| redirectと保護 | 301/302/307、別host／path、TLS不正、Vercelログインへの転送を試す。0.20.0は転送を追うので、最終JSONだけで転送なしとは証明できない。広いバイパストークンを送らない。要件を満たさなければ採用しないか、redirectを拒否する中継を別途レビューする |
| 閉じた画面・上限 | 合成OCRを31秒以上／最大実行時間近くにし、2枚以上が次の実Cronで進む。長いpg_netバッチによる送信遅延・署名120秒失効・受付停止も観測する |
| 権限・二重実行 | anon／authenticatedはDB・画像・Vault・net・運用関数へ触れない。service_roleにも運用関数とtransport書込を渡さない。8接続でも同slot／nonce・画像・通知は二重確定しない |

## 費用とクラウドを選ぶ場合

ローカルnativeの合成試験はクラウドプロジェクトと課金AI／LINEを使わないため、ホスティング・APIの追加固定費を避けられる。ローカルの容量・メモリ・電力・通信は使う。外部TLS入口や中継を作る場合の費用は別で、無料と仮定しない。

クラウドなら、対象候補は現在のFree組織NeoPlus。ただし作成前にユーザーへ対象組織を確認してからコネクタの費用見積を取る必要がある。Freeの2プロジェクト枠は所有／管理する全組織をまたぐため、見えている本番が1件でも残枠ありとは断定できない。非ゼロ見積なら作成せず金額と代替案を報告する。組織のPro化・VercelのPro化は行わない。[Supabase課金とFree枠](https://supabase.com/docs/guides/platform/billing-on-supabase)

採用後の毎分実行は30日で43,200呼出しになり、DB照会・送信記録・応答照合・Vercel実行、実解析時のAI／LINE使用量が残る。別固定課金が必須であるとは確認していないが、総費用0や配送時刻は保証しない。実LINE・iOS/PWA・Storage実サービス、バックアップと復元確認も公開前に残る。
