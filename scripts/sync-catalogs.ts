import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { generateText, Output, stepCountIs } from "ai";
import * as dotenv from "dotenv";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing environment variables (.env.local)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const googleAi = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

const catalogUrlSchema = z.object({
  url: z.string().nullable(),
  catalog_name: z.string(),
  year: z.number(),
});
const BUCKET_NAME = "wallpapers-catalogs";
const MANUFACTURERS = ["サンゲツ", "リリカラ", "トキワ", "東リ", "シンコール", "ルノン"];

/** JSONフェンスの除去 */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return trimmed;
}

const OFFICIAL_DOMAINS: Record<string, string> = {
  "サンゲツ": "sangetsu.co.jp",
  "リリカラ": "lilycolor.co.jp",
  "トキワ": "tokiwa.net",
  "東リ": "toli.co.jp",
  "シンコール": "sincol-group.jp",
  "ルノン": "runon.co.jp"
};

async function validatePdfUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok && res.status === 200) return true;
    
    // HEAD拒否サーバー対策で少量のGETを試みる
    const resGet = await fetch(url, { method: "GET", headers: { Range: "bytes=0-100" } });
    if (resGet.ok || resGet.status === 206 || resGet.status === 200) return true;
    
    return false;
  } catch (e) {
    return false;
  }
}

/** 1. Gemini + Google Search ツールによる PDF URL 抽出（googleSearchRetrieval は新 API で非対応のため google_search を使用） */
async function searchLatestCatalogUrl(manufacturer: string) {
  const domain = OFFICIAL_DOMAINS[manufacturer] || "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`   [Attempt ${attempt}] AI検索エージェント作動中...`);
    let prompt = `壁紙メーカー「${manufacturer}」の日本法人の【最新（2025年や2026年等）の壁紙カタログ】を見つけ出してください。
戦略:
1. まず、メーカーの「デジタルカタログ一覧」や「見本帳一覧」のページを検索して見つけてください。
2. その一覧ページの内容から、最新の壁紙カタログ（見本帳や仕様価格表）の「PDFの直リンク」を特定してください。
必ずドメイン ${domain ? `"${domain}"` : "（公式サイト）"} の情報を優先してください。古すぎるもの（2023年等）は無視します。

見つかった場合:
- url は必ず .pdf で終わる HTTPS の直リンクのみ
- catalog_name はカタログの正式名称
- year は版の年（数値）

見つからない場合や PDF 直リンクでない場合は url を null にすること。`;

    if (attempt > 1) {
      prompt += `\n\n【重要】前回の試行で見つけたURLはアクセス不能（404エラー等）でした。前回の検索アプローチとは違うクエリで検索するか、別のリンク（別バージョンの最新版PDFなど）を確実に見つけてください。`;
    }

    try {
      const res = await generateText({
        model: googleAi("gemini-3-flash-preview"),
        tools: { google_search: googleAi.tools.googleSearch({}) },
        stopWhen: stepCountIs(10),
        prompt,
        output: Output.object({ schema: catalogUrlSchema }),
      });

      const parsed = res.output;
      if (parsed?.url && String(parsed.url).toLowerCase().endsWith(".pdf")) {
        console.log(`   [Attempt ${attempt}] 候補URL発見: ${parsed.url} (検証中...)`);
        const isValid = await validatePdfUrl(parsed.url);
        if (isValid) {
          console.log(`   [Attempt ${attempt}] 候補URLの生存確認に成功(200 OK)しました！`);
          return parsed;
        } else {
          console.log(`   [Attempt ${attempt}] 候補URLが無効(404等)でした。リトライします...`);
        }
      } else {
        console.log(`   [Attempt ${attempt}] 有効なPDFリンクが見つかりませんでした。リトライします...`);
      }
    } catch (err) {
      console.error(`   [Attempt ${attempt}] 検索中にエラー発生:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** 2. PDFをダウンロードしてバッファ取得 */
async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error(`[Download Failed - ${url}]`, err);
    return null;
  }
}

/** 3. PDFの先頭数ページのみ切り出し (巨大サイズ防止) */
async function extractFirstPagesPdf(pdfBuffer: Buffer, maxPages = 5): Promise<string | null> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = pdfDoc.getPageCount();
    const newDoc = await PDFDocument.create();
    
    const pagesToCopy = Math.min(totalPages, maxPages);
    const pageIndices = Array.from({ length: pagesToCopy }, (_, i) => i);
    const copiedPages = await newDoc.copyPages(pdfDoc, pageIndices);
    
    for (const p of copiedPages) {
      newDoc.addPage(p);
    }
    
    const trimmedPdfBytes = await newDoc.save();
    return Buffer.from(trimmedPdfBytes).toString("base64");
  } catch (err) {
    console.error(`[PDF Trim Error]`, err);
    return null;
  }
}

/** 4. AIによる初期インデックス化（抜粋データの抽出と流し込み） */
async function indexPdfWithAI(manufacturerName: string, catalogId: string, pdfBase64: string) {
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview", generationConfig: { responseMimeType: "application/json" } });

  const prompt = `あなたは内装職人の優れたアシスタントです。添付されたカタログ仕様表PDF（の一部）を読み取り、数件（最大10件）の代表的な品番情報を以下のJSONにて抽出してください。
{
  "items": [
    { "code": "SP9512", "spec": "92cm x 50m", "repeat_v": "32.0", "repeat_h": "46.2", "pattern_match": "エンボス・無地", "notes": "防カビ等" }
  ]
}
リピートがない場合は null を設定してください。`;

  try {
    const res = await model.generateContent([
      prompt,
      { inlineData: { data: pdfBase64, mimeType: "application/pdf" } }
    ]);
    const text = res.response.text();
    const parsed = JSON.parse(stripJsonFence(text));
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    // Supabaseへのインサート
    if (items.length > 0) {
      // Get Manufacturer ID
      let { data: mfgs } = await supabase.from("manufacturers").select("id").eq("name", manufacturerName);
      let mfgId = mfgs?.[0]?.id;
      if (!mfgId) {
        const { data: newMfg } = await supabase.from("manufacturers").insert({ name: manufacturerName }).select();
        mfgId = newMfg?.[0]?.id;
      }

      for (const item of items) {
        await supabase.from("wallpapers").upsert({
          code: String(item.code),
          manufacturer_id: mfgId,
          catalog_id: catalogId,
          spec: item.spec,
          repeat_v: item.repeat_v,
          repeat_h: item.repeat_h,
          pattern_match: item.pattern_match,
          notes: item.notes,
          is_live_searched: true, // 自動追加マーク
          updated_at: new Date().toISOString()
        }, { onConflict: "code" });
      }
      console.log(`   -> Indexed ${items.length} sample items to wallpapers DB.`);
    }
  } catch (err) {
    console.warn(`   -> [AI Indexing Failed]`, err instanceof Error ? err.message : err);
  }
}

/** メイン実行関数 */
async function runAutoSync() {
  console.log("🚀 Starting Autonomous Catalog Sync Engine...\n");

  for (const mfg of MANUFACTURERS) {
    console.log(`\n======================================`);
    console.log(`🔍 [${mfg}] 検索開始...`);
    const searchResult = await searchLatestCatalogUrl(mfg);

    if (!searchResult?.url) {
      console.log(`❌ [${mfg}] 最新PDFの直リンクを発見できませんでした。スキップします。`);
      continue;
    }

    const { url, catalog_name, year } = searchResult;
    console.log(`✅ 発見: ${catalog_name} (${year}) -> ${url}`);

    // DBにて既存チェック（冪等性）
    const { data: existRecords } = await supabase
      .from("wallpaper_catalogs")
      .select("id, file_url")
      .eq("manufacturer_name", mfg)
      .eq("catalog_name", catalog_name);

    if (existRecords && existRecords.length > 0) {
      console.log(`⏭️  DBに登録済みです。スキップします。`);
      continue;
    }

    console.log(`⬇️  PDFデータのストリーミングダウンロード中...`);
    const pdfBuffer = await downloadPdf(url);
    if (!pdfBuffer) continue;

    console.log(`☁️  Supabase Storageへアップロード中...`);
    const storagePath = `${mfg}/${catalog_name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${year}_${Date.now()}.pdf`;
    
    const { data: uploadRes, error: uploadErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf" });

    if (uploadErr) {
      console.error(`❌ アップロード失敗:`, uploadErr.message);
      continue;
    }

    const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);

    console.log(`📝 メタデータの壁紙カタログテーブルへの保存...`);
    const { data: inserted, error: insertErr } = await supabase
      .from("wallpaper_catalogs")
      .insert({
        manufacturer_name: mfg,
        catalog_name: catalog_name,
        file_url: publicUrl
      }).select("id").single();

    if (insertErr) {
      console.error(`❌ DB保存失敗:`, insertErr.message);
      continue;
    }

    console.log(`🧠 自動AIインデックス化（先頭5ページを解析）...`);
    const base64PdfChunk = await extractFirstPagesPdf(pdfBuffer, 5);
    if (base64PdfChunk) {
      await indexPdfWithAI(mfg, inserted.id, base64PdfChunk);
    }

    console.log(`🎉 [${mfg}] 同期完了: ${publicUrl}`);
  }

  console.log("\n✅ All catalog sync processes completed!");
}

runAutoSync().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
