# Mac内の実Supabase検証

ユーザーが「Mac内の使い捨てSupabase起動と、試験用ローカル設定・資格情報作成」を個別承認した範囲で実施。本番・共有CLI・OSの信頼設定・実LINE・課金AIは変更／使用していない。Vercel Hobbyを維持し、クラウドプロジェクトや課金プランは作成／変更していない。

## 検証環境と境界

| 対象 | 実際に使ったもの |
| --- | --- |
| 専用CLI | 公式2.121.0、公式SHA256照合済み。共有2.90.0は未変更 |
| DB | native Postgres 17.11、今回だけのSUPABASE_HOME／stack／データディレクトリ |
| 拡張 | 実pg_cron 1.6.4、実pg_net 0.20.4、実Vault 0.3.1、実pgcrypto 1.3 |
| REST／画像 | 実PostgRESTと実Storage API、合成ユーザーと4バイトの試験画像 |
| ワーカー | 本体の署名検証、runScheduledAnalysisBatch、runAnalysisJobと実SQL／SDK。HTTPS受信サーバーのみ試験用 |
| OCR／LINE | OCRは内部test seamから31秒の合成応答。LINEはfetchで模擬受付し、実送信は遮断。その他の外部送信も拒否 |
| TLS | 一時のlocalhost試験証明書とCAファイルを、このstackのSSL_CERT_FILEにだけ指定。OSキーチェーンは未変更 |

PostgresはUnixソケットだけで待受し、CLIのプロキシと各試験HTTPサーバーはloopbackだけにbindしたことを確認。接続・鍵を含む出力は0700の専用root内の0600ファイルに保存し、チャットに出していない。試験コードはローカルURL、nativeの起動記録、専用root内のデータディレクトリを検証し、クラッシュ試験ではfixtureマーカー、対象子PIDと専用postmasterの親子関係も確認する。

本番メタデータで確認したPostgres 17.6／pg_net 0.20.0とは版が異なる。17.6の別SQL／競合試験205項目も成功しているが、このnative試験だけで本番の拡張・接続プール・Vercel制限を確認済みとはしない。

## 確認した動作

`scripts/verification/live-local-supabase.cjs` の43項目が成功した。DB時刻を変更せず実際の待ち時間を使った。

- Vaultで試験鍵が暗号化保存され、正しく復号できる。
- 実HTTPの200・401・403・429・503、socket timeout、redirectからHTMLへの到達を観測する。
- 実RESTで匿名のusers読取を拒否し、サーバー権限では同じ合成ID2件を読める。非公開Storageへサーバーで保存・読取でき、public URLからは取得できない。
- 署名付きHTTPS、nonceの一回性と実ワーカー成功記録を照合。毎分Cronと正常完了2件で受付を開く。
- 実401とTLS hostname不一致を観測すると、古いheartbeatが新しくても受付を閉じ、枠を予約しない。障害後の別UUIDの正常完了2件で復帰する。
- 31秒ずつの画像2枚を別Cronで処理し、実アプリコードで合算・最終確定・通知状態acceptedまで進める。模擬LINE受付は1回で、実LINEは送信していない。
- 実pg_netの125秒HTTPバッチで次の送信を遅らせると、120秒の署名期限を超えた要求が403になり、ワーカーを開始せず受付が閉じる。

追加確認として、実拡張のACL拒否9項目、有効化ガード3項目、クラッシュ後のREST／Storage復帰3項目が成功。netをData APIのschemaに指定した匿名HTTPは406/PGRST106で拒否された。SQLロールの広いGRANTが、そのまま匿名HTTPでのキュー読取として再現したという意味ではない。

## 実検証で補強した候補

- 非rootのMacでは443をbindできなかったため、固定HTTPS originに明示ポートを許可。1〜65535だけを受け付け、portも含むorigin全体をHMACに固定する。別portの署名は拒否する。通常の443 originは同じ。
- 実pg_netのキュー／応答表には広い既定GRANTがあった。この隔離DBだけで拡張所有者が運用者へ権限を絞り、anon／authenticated／service_roleの直接読取拒否を確認した。候補の運用雛形は権限が開いたままの有効化・送信を拒否する。本番の共有net／Vault権限は自動変更しない。
- PostgreSQLの通常ロールpostgresによるREVOKEでは、supabase_adminが付けた既定GRANTを取り消せなかった。ローカルでは組み込みの拡張所有者を使って実施した。ホスト版で可能な運用経路と他用途への影響は未確認なので、同じ操作を本番へ盲目的に適用しない。
- 実UNLOGGEDのrequest ID連番もクラッシュで1に戻る。追跡表のrequest_idを全履歴で一意とする制約を廃止し、呼出しUUIDを主キーとして実ワーカー証明と照合する。古いIDと衝突してもenqueueが止まらないことを検証する。

変更は通常migration対象外の `ops/cron/supabase-dispatch.example.sql`。通常の7本の追加migrationとPhase 2は今回変更していない。

## クラッシュ試験

`live-local-crash.cjs` は主試験完了後だけ実行する。使い捨てclusterのpg_net子プロセスを検証して停止・異常終了させ、実Postgresのcrash recoveryを使った。15項目で実キュー消失、永続dispatchとVault・合成IDの保全、過去と同じrequest IDでの登録まで成功した。

親の停止指示を受け、2026-11-03 06:18:28 UTCに状態を保存して一時停止した。対象の応答期限は06:20:45 UTCで、停止時はpending、受付はfailedで閉じた状態。その時点では実450秒期限の最終観測は未確認だった。試験Cronは0件にし、クラッシュ試験のNodeプロセスをSIGINTで停止した（終了コード-2はこの停止操作による）。主統合試験は正常終了済み。

その後の継続指示で、同じ元の要求の期限観測だけを再開した。06:23:00 UTCに実Cronがdispatchとtransport attemptの両方をexpiredへ確定し、受付が閉じたまま、試験Cronが0件になることを追加4項目で確認した。**450秒期限の最終観測も確認済み。ただし途中で意図的な停止・再開を挟んだ試験であり、450秒間連続運転して期限ちょうどの検出時間を測定した試験ではない。** 再停止のCLI終了も0。

専用stack `sokupa-pgnet-review6` は停止完了（CLI終了0）。対象rootに属する残存プロセス・TCP待受は0件と確認した。共有stackは操作していない。保護された一時ディレクトリには復旧用のローカル資格情報とDBを保持する。再開時は失効済みの古い要求を成功扱いせず、新しい試験条件を準備する。外部・本番用の資格情報はここに含まれない。

## 残る条件

- 実pg_netは別hostへのredirectにも短命の署名ヘッダーを転送した。HTML／不一致JSONは拒否し、秘密鍵そのものは送らないが、全redirectを拒否する実装ではない。採用前に固定した実Vercel入口・保護設定・転送を確認し、必要ならredirectを拒否できる方式を検討する。
- クラウドのSupabase／Vercel、実LINE Loginと通知到達、iOS Safari／PWA、本番バックアップと復元は未確認。今回のローカル資格情報作成の承認には、本番鍵生成や外部設定変更は含まれない。
- 本番の既存ユーザー／管理者無制限／IDを保つ段階移行と公開条件は引き続き適用する。ローカル通過だけで公開しない。

再実行には専用stackの起動記録と一時TLSが必要。実値を引数やチャットに置かず、保護されたrootを `SOKUPA_LOCAL_STACK_ROOT` で指定する。クラッシュ試験は追加で `SOKUPA_ALLOW_LOCAL_CRASH=1` を要求し、今回の使い捨てDB以外では実行しない。


## 最新の秘密なしwake・結果復元・保全の追補

ユーザーの閉画面完了要件に合わせ、[closed-screen-execution.md](./closed-screen-execution.md) の新方式を実装。実Cron／pg_net→実Next HTTPS→REST／Storage→実ワーカーの25項目、実Next／RESTで再発見・確認済み記録の10項目が成功。31秒×2枚はブラウザ取得・resumeなしで完了し、合成LINE受付1回。実AI／実LINEは0。

後始末のCron定義が残ったため、正確なjobnameでの型付き削除・件数確認へharnessを修正。別途、残存1件→0を確認した。最新の保全予行は21表・11ファイルを対象とし、実dump／restoreと別bucketへの全byte復元14項目が成功。元ID・所有権・metadataを保持し、試験コピーを削除。詳細と未検証範囲は [production-backup-plan.md](./production-backup-plan.md)。本番バックアップやhosted Auth／Vaultの完全復元ではない。全stack／Next／Cronは停止・解除済み。
