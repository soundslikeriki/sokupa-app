import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoBody } from "./parseMemo";
import { mergeParsedPayloads, requiresMemoReview, validateMemoEntry } from "./memo-calculation";

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

test("an omitted corrected-row candidate survives catalog certainty and still requires source review", async () => {
  const savedFetch = global.fetch;
  const names = ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = names.map(name => process.env[name]);
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY = "synthetic-no-network";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
  const fixture = { items: [{ product_code: "ZZ99001", confidence: 1, needs_review: false,
    notes: "1.00 x 12 は取り消し線があるため除外しました。",
    entries: [{ original_formula: "1.20×8" }, { original_formula: "2.70×6" }] }] };
  global.fetch = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = url.hostname === "generativelanguage.googleapis.com"
      ? { candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }], role: "model" }, finishReason: "STOP" }] }
      : url.hostname === "db.example.test" && url.pathname.endsWith("/wallpapers")
        ? { code: "ZZ99001", spec: "巾92cm", confidence: 1, is_live_searched: true, updated_at: new Date().toISOString(), manufacturers: { name: "Synthetic" }, catalogs: { name: "Synthetic" }, source_url: "https://www.sangetsu.co.jp/synthetic" }
        : null;
    if (!body) throw new Error("Blocked unexpected network request");
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await parseMemoBody({ base64Image: "AA==" });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    const item = data.items[0];
    assert.equal(item.needs_review, true);
    assert.match(item.review_reasons.join(" "), /訂正・取消/);
    assert.deepEqual(item.reading_reviews[0].candidate_formulas, ["1.00 x 12"]);
    assert.equal(item.total_m, 25.8, "do not silently assume which candidate is valid");
    assert.equal(item.reading_review_confirmation, undefined);
    assert.equal(requiresMemoReview(mergeParsedPayloads([data])), true);
    // Only an explicit human correction adds the valid candidate to the measurement rows.
    const corrected = mergeParsedPayloads([{ items: [{ ...item, entries: [...item.entries, validateMemoEntry({ original_formula: "1.00×12" })] }] }]);
    assert.equal(corrected.items[0].total_m, 37.8);
    assert.equal(corrected.items[0].order_quantity, 44);
  } finally {
    global.fetch = savedFetch;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});
