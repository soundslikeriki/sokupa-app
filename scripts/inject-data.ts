import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const dataToInject = [
  { code: "VS2038", manufacturer_name: "サンゲツ", catalog_name: "VS", spec: "92cm × 50m", pattern_match: "無地貼可", repeat_v: "32", repeat_h: "46.2", notes: "防カビ / 表面強化" },
  { code: "VS2065", manufacturer_name: "サンゲツ", catalog_name: "VS", spec: "92cm × 50m", pattern_match: "無地貼可", repeat_v: "64", repeat_h: "92.5", notes: "防カビ / 下地注意" },
  { code: "SP2598", manufacturer_name: "サンゲツ", catalog_name: "SP", spec: "92cm × 50m", pattern_match: "無地貼可", repeat_v: null, repeat_h: null, notes: "防カビ / 撥水 / 軽量" },
  { code: "TWS8211", manufacturer_name: "トキワ", catalog_name: "パインブルS", spec: "92cm", pattern_match: "無地貼可", repeat_v: "0", repeat_h: "0", notes: "防カビ / 難燃" },
  { code: "TWP9603", manufacturer_name: "トキワ", catalog_name: "パインブル", spec: "92cm", pattern_match: "リピート合わせ", repeat_v: "30.5", repeat_h: "92", notes: "防カビ / トップコート" },
  { code: "LW811", manufacturer_name: "リリカラ", catalog_name: "LIGHT 2024-2027", spec: "92cm", pattern_match: "無地貼可", repeat_v: "0", repeat_h: "0", notes: "抗菌 / 撥水" },
  { code: "SLP711", manufacturer_name: "シンコール", catalog_name: "SL+PLUS", spec: "92cm", pattern_match: "無地貼可", repeat_v: "0", repeat_h: "0", notes: "防カビ" },
  { code: "WVP4010", manufacturer_name: "東リ", catalog_name: "環境素材コレクション", spec: "92cm", pattern_match: "無地貼可", repeat_v: null, repeat_h: null, notes: "環境配慮" },
];

async function inject() {
  console.log("🚀 強制データ注入開始...");

  for (const item of dataToInject) {
    // まずメーカーのIDを取得
    let { data: mfgs } = await supabase.from("manufacturers").select("id").eq("name", item.manufacturer_name);
    let mfgId = mfgs?.[0]?.id;
    if (!mfgId) {
      const { data: newMfg } = await supabase.from("manufacturers").insert({ name: item.manufacturer_name }).select();
      mfgId = newMfg?.[0]?.id;
    }

    // カタログのIDを取得
    let { data: cats } = await supabase.from("catalogs").select("id").eq("manufacturer_id", mfgId).eq("title", item.catalog_name);
    let catId = cats?.[0]?.id;
    if (!catId) {
      const { data: newCat } = await supabase.from("catalogs").insert({ manufacturer_id: mfgId, title: item.catalog_name }).select();
      catId = newCat?.[0]?.id;
    }

    // テーブルにUPSERT
    const { error: upsertErr } = await supabase.from("wallpapers").upsert({
      code: item.code,
      manufacturer_id: mfgId,
      catalog_id: catId,
      spec: item.spec,
      repeat_v: item.repeat_v,
      repeat_h: item.repeat_h,
      pattern_match: item.pattern_match,
      notes: item.notes,
      is_live_searched: true, // Auto flag
      updated_at: new Date().toISOString()
    }, { onConflict: "code" });

    if (upsertErr) {
      console.error(`❌ エラー [${item.code}]:`, upsertErr.message);
    } else {
      console.log(`✅ データ注入完了: ${item.code}`);
    }
  }

  // 物理確認のために SELECT して出力する
  console.log("\n--- クラウドDBの格納状態を物理確認 ---");
  const codes = dataToInject.map(d => d.code);
  const { data: verified, error: verifyErr } = await supabase
    .from("wallpapers")
    .select("code, spec, repeat_v, repeat_h, notes, manufacturers(name)")
    .in("code", codes);

  if (verifyErr) {
    console.error("❌ テーブル存在確認エラー:", verifyErr.message);
  } else {
    console.log(`✅ wallpapers テーブルから ${verified.length} 件のレコードを正常に読み込みました。`);
    for (const v of verified) {
       console.log(` [${v.code}] ${(v.manufacturers as any)?.name} - 規格: ${v.spec || ""} / 備考: ${v.notes || ""}`);
    }
  }
}

inject().catch(console.error);
