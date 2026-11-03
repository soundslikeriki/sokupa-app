# 本番切替と復旧

ユーザーは、安全確認後の公開、Production専用SESSION_SECRET 1個の生成・登録、Supabaseの毎分wakeを承認済み。Hobbyを維持する。実LINEの試験送信、有料AIの試験、新しいVercel保護bypass資格情報、権限拡張や有料プランはこの承認に含めない。

## 今回の追加保護

Next.jsをサポート対象の16.4.4、Reactを19へ更新した。動的ルートparamsとcookiesの非同期APIへ追従し、既存webpack画像変換を維持する。React Compilerは無効。型・lint・本番ビルド、単体79件、ブラウザ176件（合成PNG/JPEG/Apple HEICの実変換を含む）が成功。production依存監査は0件。開発依存の全警告解消や実iPhone検証は主張しない。[Next.jsサポート方針](https://nextjs.org/support-policy)

12本目のmigrationは旧版ジョブの再実行を防ぐ。`execution_mode=legacy`のジョブはワーカー／未完了一覧から除外し、再開APIも拒否する。完了済み履歴は読める。既存の結果・状態・ユーザーIDは削除せず、旧未完了ジョブは画像を選んで明示的に新規解析する。旧版の長期未完了ジョブを新workerが自動再解析・再通知することはない。

`seal_legacy_analysis_jobs()`はrootだけが呼べる一度限りの境界であり、disabled中に旧受付を閉じ、旧workerをdrainしてから実行する。Phase 2はworker→wake→policy→対象tableの順にlockし、非公開化とsealを同一transactionで行う。seal未完了では受付しない。seal後の新ジョブは再開可能で、同じsealの再実行で新ジョブをlegacyへ戻さない。

## 保全

作業コピー外の0700ディレクトリに、全schemaのnative論理dump、パスワードなしrole定義、Storage metadataと全実ファイルを0600で保存する。行・ID・owner/RLS・table/column ACL・関数を別ローカルDBへの復元と照合し、12本＋Phase 2の移行後も元の業務列を照合する。Storageは全byteのSHA256／size、取得できる場合MD5も照合する。秘密、実データ、画像、バックアップをGit／Vercelへ送らない。

Supabase管理roleのgrantorは通常のローカルPGへ完全再現できないため、検証用コピーだけでgrantor句を調整し、実効権限を照合する。元dumpは変更しない。別projectへのAuth／Vault master-key全復旧を保証した検査ではない。今回のapp移行はplatform role・Auth・Vault・実画像を変更しない。

## 手順

1. 元の公開deployment／GitHub mainと本番接続先を照合し、未完了ジョブと更新時刻を再確認する。バックアップと移行予行を確認する。SESSION_SECRETをProductionだけへstdinで登録し、既存LINE／admin／Supabase値を維持する。
2. 新コードをProduction設定で`deploy --prod --skip-domain`し、build／runtime設定を確認する。旧URLはまだ切替しない。`ANALYSIS_BACKGROUND_MODE=scheduled-wake`、`ANALYSIS_WAKE_ENABLED=true`としてもDB disabled／seal未完了なら受付は閉じる。
3. 追加migration12本を順番に適用する。DB modeをdisabledにする。旧クライアントは追加段階では動かせるが、新旧混在のまま受付を開かない。
4. canonical aliasを新コードへ切替し、旧workerの最大寿命以上（6分以上）drainする。旧deploymentの動的入口も保護されていることを確認する。新APIの署名拒否・OAuth開始設定を確認する。旧クライアントの匿名DB書込みをPhase 2で閉じる。
5. 最終データ差分を保全し、Phase 2（非公開化＋seal）をtransactionで実行する。匿名DB／Storage拒否、serverによる同じファイル読取、ユーザー／無制限IDの保全、`analysis_processing_secure()`を確認する。
6. 承認済みpg_cronと`ops/cron/supabase-wake.example.sql`を導入する。rootのoriginを正確なcanonical HTTPS、modeをscheduled-wake、expect_processingをtrueにする。毎分1件のreconcile→enqueueを登録する。net／Vaultのowner・ACLは変更しない。旧legacyジョブしかない空queueから始め、実HTTP応答と独立private正常完了2回で`analysis_admission_ready('scheduled-wake')=true`を確認する。
7. 公開URL、受付の実用状態、保護・エラー・使用量を確認する。本人にLINE再ログインとiPhoneの写真解析／閉画面／編集復元／発注の確認を案内する。代行で実AI／LINEを試す場合は宛先・枚数・費用範囲を個別に確認する。未実施の実機・通知到達を検証済みと呼ばない。

installed CLI51.1の`vercel curl`は既存bypassがない場合に新しいbypass秘密を自動作成する。ここでは使用しない。既存ブラウザ認証、または制御された切替後の公開canonicalで確認し、Deployment Protectionを無効化しない。共有リンクも生成しない。

## 障害時

新規受付をdisabledにし、必要ならこのappのCronだけunscheduleしてdrainする。データは保持する。署名セッションと非公開ACLを維持した修正版へforward fix／同方式の検証済みdeploymentへ戻す。旧匿名DBクライアントへそのまま戻したり、public ALL／公開bucketを復活させたりしない。

sealは一度限りで、過去通知をpendingへ戻さない。結果不明のLINEは重複送信しない。業務行の復元が必要な場合は新しい正当な更新を別保全し、元のIDを保った必要最小範囲だけ復旧する。全dumpの上書き復元は通常rollbackとして実行しない。

毎分起動は月約43,200回のHTTPとDB処理を消費する。Hobbyを有料へ変更しないが、利用枠やprovider障害による制限がないとは保証しない。健康状態が失われた場合は既存の結果を保ち、受付を安全に止め、別の正常完了2回から復帰する。
