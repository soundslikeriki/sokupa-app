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
  console.log("このコードをユーザーに共有してください。");
}

main();

