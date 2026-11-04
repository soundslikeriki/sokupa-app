# 旧版を維持した追加検証と公開前の手順（2026-11-04）

> 追補: 最新snapshotからの隔離移行39項目と、基本表示fallbackの通常／基本切替13＋基本165項目を検証した。[追加結果](./migration-rehearsal-and-fallback.md) が移行予行・fallbackの現状に優先する。

この記録が11月3日の公開／切替手順に優先する。旧版復帰後のデータを保全し、本番を変更せずに検証した。拒否されたM4、期限切れのPhase 2、前日の公開承認を再利用していない。本番DDL・Cron・環境変数・alias・権限・プランの変更は行っていない。

## 現在の版と検証

canonicalの読取確認は `919379d9e45e367a45d3b6f64b01724a528fe3f2`／`dpl_AZDxpxoziaJP68E7vWJtPNuS7u4V`。DBに適用済みなのは追加migrationの最初の3本。旧版の匿名DB／公開画像アクセスは現在の利用維持のためそのままであり、セキュリティ改善完了を意味しない。

別worktreeの修正版を、公式Node `24.22.2`（darwin-arm64、公式HTTPS checksum照合）で検査した。システムNode 25や共有依存は変更していない。

独立レビューの4件には次を修正した。

- 自動置換の同意は、解析ボタンを押した時点のworkspaceに限定する。アップロード待ち中の編集も完了後の選択対象となり、再読込しても保持する。
- 長さ／幅数の空欄を最後の有効な数値と別に保存する。空欄中は比較条件を未確認とし、コピーと発注下書きへの追加を無効にする。埋め直した後も確認操作が必要。
- 行リセットはsource row IDで元行を探す。旧データは式と出典が一意な場合だけ対応付け、配列位置では戻さない。元行が曖昧なら値を変えず確認を促す。
- 解析受付は最初のawaitより前に同期guardを確保する。保存ロック待ちの連打を1回にまとめ、受付失敗後の明示的な再試行は可能。

Node 24で単体193件、型、lint、本番形式buildが成功。最終版のブラウザは既存217＋追加33＝250項目が成功。実Cron／pg_netの追加25項目も成功（後述）。すべて合成データで、実AI呼出し・LINE実送信はゼロ。

## 最新のオンライン保全と復元

2026-11-04 11:13–11:16 UTCに、既存CLIの通常の短命接続とverify-full TLSで、read-only repeatable-readのexported snapshotを取得した。アプリの停止や書込みは行っていない。DB dumpと行fingerprintは同じsnapshotから取得した。CLI接続用の通常の一時認証以外に資格情報や恒久権限を追加していない。

| 対象 | 今回の保全・確認 |
| --- | --- |
| 全DBの論理dump | 588,223 byte、SHA256 `a85a38a783d3fa2ed5c18e36fa96608aebaa9191b3c63101b50f96a1b9384514` |
| アプリ／運用等 | public 13、auth 27、storage 10、net 2、supabase_functions 2、supabase_migrations 1、vault 1：計56表804行 |
| 最新の業務データ | 解析ジョブ121、画像明細175。前日dumpの120ジョブへ戻してはいけない |
| Storage実ファイル | 全181個、53,656,038 byte。ID／owner／metadata対応manifest、SHA256・size・可能なMD5、全byte読戻しを照合 |
| roleと権限 | passwordなしrole定義、owner／RLS／policy／table・column ACL／public関数を保存 |
| 復元 | 新しいMac内のUnix-only PostgreSQLへ全dumpをrestoreし、全56表の行・ID・権限等のfingerprint一致。復元先は停止済み |

DB・画像・秘密をGit、Vercel、Library、合成Supabase、外部の復元先へアップロードしていない。実データの復元先はHTTP／TCP入口を持たず、pg_netのworker接続先は空の別DBに限定した。追加migrationをこの復元先に適用していない。管理roleのgrantor句20箇所だけを検証用roleコピーで省略し、実効ACLを照合した。元dumpは変更していない。

画像取得後も、本番のjob・image・Storage metadataの全行hashがsnapshotと一致した。受付は継続しているため、これはその時点のオンライン保全であり、将来の切替用の最終checkpointではない。最新バックアップはrepo外の0700 directory／0600ファイルに保管。通常ログやレビュー用bundleに含めない。

sourceはPostgres 17.6、復元先nativeは17.11。public custom operatorは0件で、該当upgradeのoperator復元制限は今回のcloneに発生しなかった。本番Postgresや拡張はupgradeしていない。

Vault secretは0件。Authのデータとschemaは論理復元したが、Supabaseサービス設定／外部LINE・Vercel設定／別projectのマスター鍵まで含む災害復旧を保証していない。Storageの全byteは保全したが、今回の実画像をStorage APIへ再アップロードする試験は行っていない。過去の合成Storage復元試験と区別する。[公式backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

## 今の本番から移行するための条件

現在の修正版を3-migrationのDBへコードだけ配備すると、必要なRPC／列や稼働条件が揃わず受付503になる。今の旧版利用を妨げるため、その公開はしない。次は**未実行の設計**であり、本番操作の許可待ちコマンドではない。

1. 独立レビューの修正を再確認し、実iPhoneのLINE開始→戻り先→署名session、Safari／LINE内ブラウザ／PWAを非本番で確認する。state照合を外さない。canonicalとalias、キャンセル、同時ログイン、エラー日本語表示も含める。
2. 現在の3本からのmigration差分を改めてレビューする。M4以降を以前の拒否／承認の続きとして実行しない。破壊・全履歴書換え・既存IDの再作成を避け、追加段階で旧版が動くことを隔離DBで確認する。追補の隔離予行は [migration-rehearsal-and-fallback.md](./migration-rehearsal-and-fallback.md) を参照。本番への適用はしていない。
3. 切替時点で改めて未完了・更新中・通知不明のjobを確認する。新しい正規jobを古い作業と一括分類しない。本人の受理済みjobは完了まで待ち、状態が不明なら個別判断に残す。古いjobの有料再解析や再通知を自動実施しない。
4. 新旧受付の境界、旧dynamic入口の扱い、最大worker寿命後のdrain条件を具体化し、限定した保守時間を合意してから最終のDB＋Storage checkpointを取る。移行開始後の新規行も別途保全する。いまの利用を止めてこの手順を先行しない。
5. 署名APIへのclient切替、RLS／private Storage、legacy境界、disabled modeの順序をひとつのcutoverとしてレビューする。旧clientの直接読取・uploadだけを先に閉じない。現在のseal関数は全pre-cutover行を対象にするため、新規受付が混在したまま呼ばない。
6. 稼働対象のホストとHTTPS、redirect／保護、実DBからの到達を確認する。秘密をpg_netへ渡さないwake案について、新しい2回のprivate成功、障害時の受付停止、復帰を確認した後に受付する。設定不備で503のまま公開しない。
7. LINE/device ID、招待履歴NULLの既存ユーザー、admin unlimited、利用枠、最新job/image/result/notificationの対応を比較する。LINE APIのacceptedを実端末への到達と呼ばない。実LINE試験や有料AI試験は別途の具体的な承認が必要。

## 切戻しの判断

**今回の作業は本番を変更していないため、現在は切戻し操作自体が不要。** 旧版が動く3-migration状態を維持している。

将来RLSを閉じた後の `919379d` への単純alias切戻しは、匿名DB／直接uploadを使う旧版を壊す。public ALLの復活を安全な復旧手順にはしない。新しいコードと同じschema／署名API／private Storage／worker方式を扱えるfallbackを用意し、移行後の隔離DBで先に確認する必要がある。前段の`17f0f8f`を未検査のfallbackとして使わない。新しい空欄編集保存などを古いclientが落とす可能性があるため、draft互換性も確認する。

障害時は新規受付を閉じ、既存jobの処理・通知状態と切替後の差分を保全して、互換性のある修正版へ戻す／進める。done／accepted／uncertainを一括pendingへ戻さない。dump全体の上書き復元で切替後のjobを消さない。同一IDの差分取り込み・通知retry key・Storage差分を確認してから判断する。hosted復元とVercel上の互換fallback切替は公開前に残る。ローカルで準備した基本表示は追補を参照。

## 非本番iPhone確認への経路

[実機確認の分離計画](./iphone-isolation-plan.md)を参照。既存Previewへそのまま配備すると本番DB／LINE設定を共有し得るため、別URLだけでは分離にならない。実callbackの追加、新しい外部環境／資格情報、保護設定変更、実送信、追加料金を無断で行っていない。

## 追加の実Cron検証結果

Node 24.22.2＋実Next HTTPS入口＋使い捨てSupabaseのpg_cron 1.6.4／pg_net 0.20.4／Vault 0.3.1で25項目成功。合成専用markerと既存2ユーザーだけを検査し、既存ローカルの11本までのschemaにM12 guardだけを準備した。本番M4を再実行していない。新しい実稼働Cronを本番に作っていない。

- 2回の実Cron／private worker成功で稼働条件が成立する。
- 実pg_netキューのURL／header／bodyに資格情報、permit／job／user IDを渡さない。
- 署名session、本人admin、private Storage uploadを実HTTPで確認した。
- 各31秒の合成画像2枚がブラウザpoll／resumeなしで完了し、合計40m・発注46mに一致。画像2回、合成LINE acceptance1回で、adminの利用枠は増えず、既存合成ユーザーIDも変わらない。
- 実HTTP401を観測すると、過去の正常heartbeatが残っていても受付を止め、一般利用枠を予約しない。別の正常Cron2回で復帰する。

試験用NextとCronは終了処理で停止した。native stackも対象IDだけを指定して停止し、DB／APIとUI試験ポートにlistenerがないことを確認済み。最初の起動は既定の余分なcapabilityでtimeoutしたため停止し、DB／REST／Storageに限定して再起動した。期限切れのlocalhost証明書は承認済みのローカル試験用として更新し、試験プロセスのCAファイルだけで信頼した。OSキーチェーン／本番の鍵・証明書は変更していない。

これはVercel本番入口、実LINEログイン／実配送、iPhone Safari／PWAの試験ではない。本番pg_net 0.20.0とローカル0.20.4の差、Vercelのredirect／保護／実行制限、hosted restore、Vercel上での移行／互換fallback切替は未検証として残る。最新snapshotのローカル移行予行は追補で実施した。
