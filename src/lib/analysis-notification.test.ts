import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisCompletionMessages } from "./analysis-notification";
import { buildOrderRequestText } from "./order-text";
import type { MemoProductItem, ParsedMemoPayload } from "../types";

const item = (code = "TEST001", extra: Partial<MemoProductItem> = {}): MemoProductItem => ({ product_code: code, manufacturer: "Synthetic", entries: [{ original_formula: "20×1", length_m: 20, quantity: 1, subtotal_m: 20 }], total_m: 20, order_quantity: 23, ...extra });
const date = new Date("2026-01-01T01:02:00Z");
const text = (result: ParsedMemoPayload) => buildAnalysisCompletionMessages(result, "Synthetic", date).slice(1).map(m => m.text).join("\n");
test("ordinary automatic order list retains the familiar quantity-bearing text", () => {
  const items = [item(), item("TEST002", { order_quantity: 12 })];
  assert.equal(text({ items }), buildOrderRequestText(items, "Synthetic").replace(/日時：[^\n]+/, "日時：2026年1月1日 10:02"));
});
test("one uncertain product cannot suppress itself or the other quantities", () => {
  const result = text({ items: [item("TEST001", { needs_review: true }), item("TEST002")], needs_review_any: true });
  assert.match(result, /TEST001 \/ 数量：23m（要確認・参考値）/);
  assert.match(result, /TEST002 \/ 数量：23m\n?$/);
});
test("correction and image evidence keep quantity history explicitly provisional", () => {
  const result = text({ items: [item()], notes: "訂正候補を原画像で確認してください。" });
  assert.match(result, /23m（要確認・参考値）/);
  assert.match(text({items:[item()],image_needs_review:true}),/要確認・参考値/);
});
test("a six-product correction memo retains all six quantities in automatic history", () => {
  const items=Array.from({length:6},(_,n)=>item(`ANON${n+1}`,{needs_review:true,reading_reviews:[{reason:"別行の訂正を照合してください",candidate_formulas:[]}]}));
  const messages=buildAnalysisCompletionMessages({items,needs_review_any:true},null,date);
  assert.equal(messages.length,2);
  for(const row of items)assert.match(messages[1].text,new RegExp(`${row.product_code} / 数量：23m`));
  assert.equal((messages[1].text.match(/要確認・参考値/g)??[]).length,6);
});
test("missing or invalid order quantities never fall back to the raw measured total", () => {
  for (const order_quantity of [undefined, null, 0, -1, NaN, Infinity, "" ] as unknown as number[]) {
    const result=text({items:[item("TEST001",{order_quantity})]});
    assert.match(result,/数量：未確定（要確認）/); assert.doesNotMatch(result,/数量：20m/);
  }
});
test("long lists are split with all quantities within LINE request bounds", () => {
  const items=Array.from({length:300},(_,n)=>item(`TEST${String(n).padStart(4,"0")}`));
  const messages=buildAnalysisCompletionMessages({items},"Synthetic",date);
  assert.ok(messages.length>2 && messages.length<=5);
  assert.ok(messages.every(m=>m.text.length<=4900));
  for (const row of items) assert.ok(messages.some(m=>m.text.includes(`${row.product_code} / 数量：23m`)));
});
test("request-limit overflow is explicitly counted, with quantities still present", () => {
  const messages=buildAnalysisCompletionMessages({items:Array.from({length:2000},(_,n)=>item(`TEST${n}`))},"Synthetic",date);
  assert.equal(messages.length,5); assert.ok(messages.every(m=>m.text.length<=4900));
  assert.match(messages.at(-1)!.text,/残り\d+品番は省略/);
  assert.match(messages[1].text,/数量：23m/);
});
