import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMemoFormula, validateMemoEntry, mergeParsedPayloads, parseVisionJson, repeatCutLength } from "./memo-calculation";
import type { MemoProductItem } from "../types";
import { calculateFinalQuantity, calculateOrderQuantity } from "./calc-logic";

test("field width additions and subtraction precede multiplication", () => {
  assert.deepEqual(evaluateMemoFormula("2.5×7+4-3"), { length: 2.5, quantity: 8, subtotal: 20, ambiguous: false });
  assert.equal(evaluateMemoFormula("2.70×60+5+5+84")?.subtotal, 415.8);
  assert.equal(evaluateMemoFormula("２．５×（７＋４－３）")?.subtotal, 20);
  const entry = validateMemoEntry({ original_formula: "2.5×7+4-3", length_m: 2.5, quantity: 8, subtotal_m: 999 });
  assert.equal(entry.subtotal_m, 20);
});

test("hyphen decimal ambiguity and unreadable formulas stay under review", () => {
  for (const formula of ["1-30×7", "2.5×7-3", "読み取り不明"]) {
    const entry = validateMemoEntry({ original_formula: formula, length_m: 1.3, quantity: 7, subtotal_m: 999 });
    assert.equal(entry.needs_review, true);
    assert.ok(entry.review_reason);
  }
  assert.equal(evaluateMemoFormula("2.5×(7-3)")?.ambiguous, false);
  assert.equal(evaluateMemoFormula("process.exit()"), null);
});

test("invalid/empty OCR JSON and missing entries are failures", () => {
  for (const text of ["bad json", "{}", '{"items":[]}', '{"items":[null]}', '{"items":[{"entries":[]}]}']) assert.throws(() => parseVisionJson(text));
  assert.equal(parseVisionJson('```json\n{"items":[{"entries":[{}]}]}\n```').items.length, 1);
  assert.throws(() => validateMemoEntry({ length_m: "bad", quantity: 2 }));
});

test("multiple images sum all entries, recompute loss once and preserve review reasons", () => {
  const item = (formula: string, code: string): MemoProductItem => ({ product_code: code, manufacturer: "Test", entries: [validateMemoEntry({ original_formula: formula })], total_m: 999, order_quantity: 999 });
  const first = item("2.5×7+4-3", "vs-2067");
  const second = { ...item("3×2", "VS2067"), needs_review: true, review_reasons: ["品番：要確認"] };
  const merged = mergeParsedPayloads([{ items: [first] }, { items: [second] }]);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].total_m, 26);
  assert.equal(merged.items[0].order_quantity, 30);
  assert.equal(merged.items[0].entries.length, 2);
  assert.equal(merged.needs_review_any, true);
  assert.equal(first.total_m, 999); // source remains intact
});

test("repeat rounding is stable at floating point boundaries", () => {
  assert.equal(repeatCutLength(2.7, 60), 3);
  assert.equal(repeatCutLength(repeatCutLength(2.7, 60), 60), 3);
  assert.equal(repeatCutLength(0.21, 7), 0.21);
});

test("20m from decimal rows orders 23m at 15%, without hiding real excess", () => {
  const total = 2.7 * 6 + 3.8;
  assert.ok(total > 20);
  assert.equal(calculateOrderQuantity(total, 15), 23);
  assert.equal(calculateFinalQuantity(total), 23);
  assert.equal(calculateOrderQuantity(20.00000001, 15), 24);
  assert.equal(calculateOrderQuantity(100, 10), 110);
});

test("null, empty and non-numeric OCR fields never become successful zero measurements", () => {
  for (const value of [null, undefined, "", " ", false, true, [], {}, NaN, Infinity, -1, 0]) {
    assert.throws(() => validateMemoEntry({ original_formula: "", length_m: value, quantity: value }));
  }
  assert.equal(validateMemoEntry({ original_formula: "2.5×8", length_m: null, quantity: null }).subtotal_m, 20);
});
