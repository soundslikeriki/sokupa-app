# 最新snapshotの移行予行と基本表示fallback

2026-11-04の追加検証。本番は旧版919379dと追加migration3本のまま。以下はMac内の隔離予行であり、本番M4／失効したPhase 2の再試行ではない。

## 移行予行

最新のread-only snapshot（121ジョブ、175画像明細、181 Storage object、56表804行）を、新しい私有Postgresへ復元した。TCP入口はなく、0700のUnix socketだけで接続し、pg_net workerは空の別DBを対象とする。実画像・tokenを外部サービスへ渡さず、本番接続も使わない。最初の復元と元データの一致を確認した後に、**残り9本だけ**のmigration SQLとPhase 2を実行した。

39項目が成功した。

- 既存3本の状態、および残り各migrationの後に、旧版相当のjob作成・worker更新・匿名poll・Storage insertをtransaction内の試験行で確認した。すべてrollbackし、実データは変更しない。
- 追加9本後、全56表の元列・元行のhashが元snapshotと完全一致した。ユーザー／招待／無制限／利用枠／結果／通知／画像IDを含む。
- execution policyの初期値は`scheduled`。private accessが未成立なので新方式の受付は閉じている。切替手順では明示的に`disabled`へ変更してからPhase 2へ進む。初期値がdisabledであるとは仮定しない。
- Phase 2後はprivate access判定が成立し、旧版の匿名poll／uploadが権限エラーになる。旧コードへの単純alias切戻しが動かない境界を実SQLで確認した。
- 121ジョブ・175画像明細・181画像レコードのID／結果／通知等は保持され、旧ジョブは再開対象0件。既存のStorage bucket設定変更と運用health状態の初期化は意図した差分として区別した。
- 切替後に新しい試験jobを追加すると再開対象に入り、sealを再確認してもlegacyへ戻らず保持された。試験jobは最後にrollbackした。

今回の予行はSQL本体の検証。元のmigration履歴3行は保持し、MCPが本番へ追加する9件の履歴書込みは模擬していない。ローカルfilenameと既存hosted履歴のversion対応は、実施前にnameとSQL hashで再照合する。過去3本を再適用しない。

実データの復元先は停止済み。予行のdump・行hash・詳細logはrepo外の保護領域に残し、Git／配備bundleへ含めない。Postgres17.6→ローカル17.11の論理予行であり、hosted platform全体の復旧やVercelへの本番配備は未実施。

## 基本表示fallback

同じ署名認証・API・private Storage・worker・保存形式を使い、写真照合ボタンと詳細な比較条件パネルを省く基本表示を用意した。解析・行編集・複数高さリピート・コピー・発注下書き・最新結果の復元は保持する。基本表示の数量には確認を促す表示を使い、緑チェックを出さない。空欄の長さ／幅数は保持し、埋めるまでコピー／下書き追加を止める。

`NEXT_PUBLIC_SOKUPA_INTERFACE_MODE=basic`を**build時だけ**指定する。省略時は通常表示。別のsourceコピーで2つのbuildを作り、同じブラウザoriginで通常→基本→通常のHTML／assetを切り替えて検証する。既存`.env.local`や本番資格情報を試験buildへコピーしない。

このfallbackはUIの切戻し候補で、旧Next14／未署名LINE ID認可／匿名DBアクセスへは戻さない。バックエンド、計算エンジン、保存処理は共通なので、それらの障害を回避する独立実装ではない。バックエンド障害では受付制御・データ保全と修正版への切替が必要になる。

将来配備する場合は、通常／基本の両方を同じcommit・同じschema・同じcanonical callback・同じ既存SESSION_SECRETで作り、未aliasの候補として確認する。どちらにも新しいDBやLINE鍵を登録しない。切替でworker modeやDBの権限・結果・通知statusを変更しない。新しい受付済みjobを消すdump復元や、acceptedをpendingへ戻す処理は行わない。本番のbuild／alias操作は今回はしていない。

実際のVercel入口でのalias切替、session Cookie保持、処理中jobとの競合、iPhone/PWAの保存は、まだ実環境での確認が必要。独立レビュー済み22f0ffaに、この基本表示用の差分を追加したため、その追加分も公開前レビューの対象とする。

## fallbackの確認結果

Node24.22.2で通常／基本の両方を本番形式buildし、型・lintを確認した。両sourceコピーのAPI／lib85ファイルはbyte単位で同一。

- 同一ブラウザoriginで通常→基本→通常の13項目が成功。新形式の空欄、元の複数高さ、手入力発注量、基本表示での編集と発注下書き、基本表示で受理したjobを閉じて通常表示へ戻った時の復元を確認。
- 基本表示で既存の165項目が成功。通知失敗後の新規受付、別job／別tabの編集保全、履歴・保留結果、旧job再実行防止、PNG/JPEG/HEICを含む。
- 通常表示では直近の4件修正33項目と統合機能32項目、計65項目を再確認。基準22f0ffaは独立レビューで193単体／250ブラウザ／画像API16項目を通過し、新しいP1/P2がないとの報告を受領済み。

これらはlocalhostと合成APIの試験。通常／基本で共通のbackendは前段の実native Cron／pg_net25項目の対象と同じで、今回backendへ変更を入れていない。Vercel上のalias切替や実LINEログインまで実行したという意味ではない。試験サーバーと実データの予行DBは停止し、本番へは反映していない。
