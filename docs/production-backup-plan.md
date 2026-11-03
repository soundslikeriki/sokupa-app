# 本番を保全して切り替える手順（未実施）

本番DB／Storageのexportはまだ取得していない。Mac内の合成予行と混同しない。公開許可はあるが、バックアップ未検査のままPhase 2や本番DDLを進めない。

## 対象の確定と取得

1. 対象Supabase `yegdgginwcmvpzeiuags`、既存LINEチャネル／admin、現本番commit・deployment・aliasを照合する。既存DB接続をConnectから保護ファイルで用意する。passwordをチャット・引数・ログへ載せない。未保持ならresetしない。
2. 短い保守時間を取り、旧解析受付・旧workerを停止し、300秒上限＋余裕の6分以上drainする。切替中のDBとファイルの整合を揃える。実行中・通知不明の仕事は一覧化し、勝手に再送しない。
3. 公式CLIのバックアップ手順でrole/schema/dataを取得する。アプリの全schema（public、適用済み運用schema、migration履歴）を列挙し、方針表・provider／worker／通知監査／wake状態・列単位ACLも含める。未適用schemaをあるものとして扱わない。[公式のbackup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
4. Storageは全対象bucketの設定、policy、全object行のID・所有者・metadataと**実ファイルの全byte**を別に取得する。DB exportだけではファイルは含まれない。object名をローカルpathとして使わず、hash名で保存し、manifestでbucket/name/ID/SHA256/byte数を対応付ける。欠落・不一致が一つでもあれば中止。[Database backups](https://supabase.com/docs/guides/platform/backups)
5. Authを使っているか、既存Vault／他の運用schemaがあるかをメタデータで棚卸しする。SokupaのLINE独自sessionだけでなくプロジェクトの他用途を勝手に除外しない。Auth／Vault／拡張・マスター鍵はアプリschema dumpの範囲外で、必要なら公式の同一project復旧／移行手順を別途確認する。Vault平文・本番tokenを通常ログへexportしない。
6. LINE／AI／Vercelの環境設定は値を広げず、必要項目・既存登録先・復旧経路を保護して記録する。元の秘密を再生成しない。SESSION_SECRET追加は個別承認後だけ行う。

## 検査と復旧

バックアップは0700の保護directoryと0600ファイルへ保存する。SHA256・件数・schema／表一覧・作成時刻を記録する。ユーザー、招待履歴NULL、無制限、利用枠、job/image ID、結果、通知状態のhashと対応を確認し、所有者が既存利用者・無制限一覧を確認する。

非本番の復元先でschema/data/function/trigger/index/RLS/table・column ACLを検査する。Storageの設定・metadata復元と全ファイル読戻しhashも確認する。別projectの作成、外部へのコピーや新規資格情報が必要なら個別確認し、無断で本番データをローカル合成stackへ混ぜない。Mac内の今回の許可は合成環境のもので、本番データ複製の追加許可とは扱わない。

ロールバックでは新規受付とCronを停止し、in-flightをdrainしてから、署名認証と非公開RLSを保つ修正版へ戻す／進める。旧匿名DB版やpublic ALLを復活させない。既存job ID・LINE retry key・通知監査を保ち、sent／accepted／legacy_unknown／uncertainを一括pendingへ戻さない。データ復元が必要なら切替以後の差分を先に保護し、重複通知を確認してから行う。

## 実施済みの合成予行と限界

`scripts/verification/local-complete-backup.cjs` を実native Supabaseで実行し、14項目成功。public・sokupa_ops・sokupa_wake_opsの21表を実pg_dump／別DBへ実pg_restore。全行／ID／通知／方針・関数・RLS・table／column ACLが一致した。ACLの暗黙owner既定値と明示owner値は同値として正規化して比較した。

全11個・44byteの合成JPEG objectをmetadata＋SHA256付きでexportし、新しいprivate bucketへコピー復元、全byte hashを検査した。元objectのID・所有者・metadataは保持。復元先のDB・bucket・コピーobjectは削除し、stackを停止した。

これは本番バックアップやAuth／Vaultを含むhosted platformの完全復元ではない。別bucketへのbyte復元ではobject IDを移植していない。元bucket設定・object metadataのexportは取得したが、新しいSupabase projectに同じStorage ID／owner／policyで完全移植する経路は未検証。実本番の保全・復旧計画をこの予行だけで完了扱いにしない。
