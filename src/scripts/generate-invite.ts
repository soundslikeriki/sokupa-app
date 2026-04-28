import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字（0,O,1,I）を除外
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const code = generateCode();

  const { error } = await supabase.from("invite_codes").insert({ code, is_used: false });

  if (error) {
    console.error("❌ 登録失敗:", error.message);
    process.exit(1);
  }

  console.log("✅ 招待コード生成完了:");
  console.log("================================");
  console.log(`   ${code}`);
  console.log("================================");
  console.log("");
  console.log("📋 以下をそのままLINEで送ってください:");
  console.log("================================");
  console.log(`ソクパのログイン手順です！

① こちらからアクセス👇
https://sokupa-app.vercel.app

② 画面に「ようこそ！ソクパへ」と出たら
「利用規約を読み、内容に同意します」の左の□をタップ✅

③ 入力欄に下の招待コードを入力

【招待コード】
${code}

↑ このコードをそのまま入力してください

④「認証する」ボタンを押す

⑤ 緑色の「LINEでログイン」ボタンを押す

⑥ LINEの画面が出たら「許可する」を押す

⑦ ソクパの画面が開いたら完了です！🎉

⑧ 【ホーム画面に追加するとアプリとして使えます！】
　iPhoneの場合：
　Safari下部の□↑ボタン →「ホーム画面に追加」をタップ
　Androidの場合：
　ブラウザ右上の⋮ →「ホーム画面に追加」をタップ

次回からはブックマークをタップするだけで直接開きます。`);
  console.log("================================");
}

main();

