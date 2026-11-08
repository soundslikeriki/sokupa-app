import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisCompletionMessages } from "./analysis-notification";
import { buildOrderRequestText } from "./order-text";
import { buildOrderDraftText } from "./order-draft";
import type { MemoProductItem, ParsedMemoPayload } from "../types";

const item = (code = "TEST001", extra: Partial<MemoProductItem> = {}): MemoProductItem => ({ product_code: code, manufacturer: "Synthetic", entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }], total_m: 20, order_quantity: 23, ...extra });
const date = new Date("2026-01-01T01:02:00Z");
const text = (result: ParsedMemoPayload) => buildAnalysisCompletionMessages(result, "Synthetic", date).slice(1).map(m => m.text).join("\n");
const noOutputAdvisory = (value: string) => assert.doesNotMatch(value, /※要確認の数量は、原画像と照合してください。|（要確認・参考値）/);

test("ordinary automatic order list matches clipboard and order-draft text without changing either path", () => {
  const items = [item(), item("TEST002", { order_quantity: 12 })];
  const output = text({ items });
  assert.equal(output, buildOrderRequestText(items, "Synthetic").replace(/日時：[^\n]+/, "日時：2026年1月1日 10:02"));
  assert.equal(output, buildOrderDraftText(items.map((row, n) => ({ id: String(n), productCode: row.product_code, quantity: row.order_quantity, unit: "m", sourceType: "dimension", sourceLabel: "Synthetic" })), "Synthetic", date));
  noOutputAdvisory(output);
});

for (const [name, result] of Object.entries<ParsedMemoPayload>({
  review: { items: [item("TEST001", { needs_review: true }), item("TEST002")], needs_review_any: true },
  correction: { items: [item("TEST001", { notes: "1.00×12は取消線のため除外", reading_reviews: [{ reason: "訂正候補を照合", candidate_formulas: ["1.00×12"], source_image_index: 0 }] })] },
  image: { items: [item()], image_needs_review: true },
  global: { items: [item()], notes: "訂正候補を原画像で確認してください。", needs_review_any: true },
})) test(`${name}: valid quantities are plain while original review evidence stays intact`, () => {
  const before = structuredClone(result), output = text(result);
  assert.match(output, /TEST001 \/ 数量：23m(?:\n|$)/); noOutputAdvisory(output);
  assert.equal(output, buildOrderRequestText(result.items, "Synthetic").replace(/日時：[^\n]+/, "日時：2026年1月1日 10:02"));
  assert.deepEqual(result, before);
});

test("six-product correction memo retains every plain quantity and all input flags", () => {
  const items = Array.from({ length: 6 }, (_, n) => item(`ANON${n + 1}`, { needs_review: true, reading_reviews: [{ reason: "別行の訂正を照合してください", candidate_formulas: [] }] }));
  const payload = { items, needs_review_any: true }, before = structuredClone(payload);
  const messages = buildAnalysisCompletionMessages(payload, null, date);
  assert.equal(messages.length, 2);
  for (const row of items) assert.match(messages[1].text, new RegExp(`${row.product_code} / 数量：23m(?:\\n|$)`));
  noOutputAdvisory(messages[1].text); assert.deepEqual(payload, before);
});

test("positive finite quantities and legacy numeric strings preserve their values", () => {
  for (const quantity of [0.25, 23, Number.MAX_SAFE_INTEGER, "23", "23.50", "0.25"]) {
    const payload = { items: [item("TEST001", { order_quantity: quantity as number, total_m: 9999, needs_review: true })] };
    const before = structuredClone(payload), output = text(payload);
    assert.match(output, new RegExp(`数量：${Number(quantity)}m$`)); noOutputAdvisory(output); assert.deepEqual(payload, before);
    assert.doesNotMatch(output, /9999m/);
  }
});

test("invalid quantities keep their explicit unresolved placeholder and never use total_m", () => {
  for (const quantity of [undefined, null, 0, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "", " ", "NaN", "Infinity", "-1", "1e2", "23m", "０", {}]) {
    const payload = { items: [item("TEST001", { order_quantity: quantity as number, total_m: 9999 })] }, before = structuredClone(payload);
    const output = text(payload);
    assert.match(output, /数量：未確定（要確認）/); assert.doesNotMatch(output, /数量：9999m/); noOutputAdvisory(output); assert.deepEqual(payload, before);
  }
});

test("invalid product codes keep their existing placeholder without losing valid quantities", () => {
  for (const code of [undefined, null, "", "  \n ", "X".repeat(161)]) {
    const payload = { items: [item(code as string, { order_quantity: 12 })] };
    // item() defaults undefined to TEST001; set the malformed fixture explicitly.
    payload.items[0].product_code = code as string;
    const before = structuredClone(payload), output = text(payload);
    assert.match(output, /品番：品番をアプリで確認 \/ 数量：12m$/); noOutputAdvisory(output); assert.deepEqual(payload, before);
  }
});

test("completion text, site sanitization and empty-list fallback remain unchanged", () => {
  const messages = buildAnalysisCompletionMessages({ items: [] }, "  Site\nA  ", date);
  assert.equal(messages[0].text, "✅ ソクパ解析が完了しました！\n現場：Site A\nアプリを開いて結果を確認してください。");
  assert.match(messages[1].text, /現場名：Site A/); assert.match(messages[1].text, /品番・数量をアプリで確認してください/);
  assert.equal(messages.length, 2); noOutputAdvisory(messages[1].text);
});

test("300 products split with all quantities within the same LINE request bounds", () => {
  const items = Array.from({ length: 300 }, (_, n) => item(`TEST${String(n).padStart(4, "0")}`, { needs_review: true }));
  const messages = buildAnalysisCompletionMessages({ items }, "Synthetic", date);
  assert.ok(messages.length > 2 && messages.length <= 5); assert.ok(messages.every(m => m.text.length <= 4900));
  for (const row of items) assert.ok(messages.some(m => m.text.includes(`${row.product_code} / 数量：23m`)));
  noOutputAdvisory(messages.map(m => m.text).join("\n"));
});

test("2000-product overflow still names the exact omitted count and uses at most five texts", () => {
  const messages = buildAnalysisCompletionMessages({ items: Array.from({ length: 2000 }, (_, n) => item(`TEST${n}`, { needs_review: true })) }, "Synthetic", date);
  assert.equal(messages.length, 5); assert.ok(messages.every(m => m.text.length <= 4900));
  const output = messages.slice(1).map(m => m.text).join("\n"), rows = [...output.matchAll(/品番：(TEST\d+) \/ 数量：23m/g)].map(m => m[1]);
  const remaining = output.match(/残り(\d+)品番は省略/);
  assert.ok(remaining); assert.equal(new Set(rows).size, rows.length); assert.equal(rows.length + Number(remaining[1]), 2000);
  noOutputAdvisory(output);
});
