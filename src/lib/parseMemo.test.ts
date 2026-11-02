import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoBody } from "./parseMemo";
import { mergeParsedPayloads, requiresMemoReview } from "./memo-calculation";

test("root image uncertainty survives catalog enrichment, merging and notification eligibility", async () => {
  const savedFetch = global.fetch;
  const names = ["GEMINI_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map((name) => process.env[name]);
  process.env.GEMINI_API_KEY = "synthetic-no-network";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
  let fixture: any = { image_needs_review: true, items: [{ product_code: "VS2067", confidence: 0.99, entries: [{ original_formula: "2.5×8", length_m: 2.5, quantity: 8 }] }] };
  global.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = url.hostname === "generativelanguage.googleapis.com"
      ? { candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }], role: "model" }, finishReason: "STOP" }] }
      : url.hostname === "db.example.test" && url.pathname.endsWith("/wallpapers")
        ? { code: "VS2067", spec: "巾92cm", confidence: 0.99, is_live_searched: true, updated_at: new Date().toISOString(), manufacturers: { name: "サンゲツ" }, catalogs: { name: "Synthetic" }, source_url: "https://www.sangetsu.co.jp/synthetic" }
        : null;
    if (!body) throw new Error("Blocked unexpected network request");
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await parseMemoBody({ base64Image: "AA==" });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.image_needs_review, true);
    assert.equal(data.items[0].needs_review, true);
    assert.match(data.items[0].review_reasons.join(" "), /画像/);
    assert.equal(requiresMemoReview(mergeParsedPayloads([data])), true);
    fixture = { items: [{ product_code: "", entries: [{ original_formula: "", length_m: null, quantity: null }] }] };
    assert.notEqual((await parseMemoBody({ base64Image: "AA==" })).status, 200);
  } finally {
    global.fetch = savedFetch;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});
