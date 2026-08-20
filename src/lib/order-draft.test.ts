import assert from "node:assert/strict";
import test from "node:test";

import {
  areaResultToOrderDraftInput,
  buildOrderDraftText,
  calculateOrderDraftTotals,
  consumeOrderDraftQueue,
  createOrderDraftItem,
  dimensionItemToOrderDraftInput,
  findDuplicateOrderDraftItem,
  manualOrderDraftInput,
  mergeOrderDraftItem,
  normalizeOrderDraftProductCode,
  removeOrderDraftItem,
  updateOrderDraftItem,
} from "./order-draft";
import type { MemoProductItem, OrderDraftItem } from "../types";

const dimensionSource: MemoProductItem = {
  product_code: "TH-34486",
  manufacturer: "サンゲツ",
  entries: [{ original_formula: "2.7 x 10", length_m: 2.7, quantity: 10, subtotal_m: 27 }],
  total_m: 27,
  order_quantity: 32,
  loss_rate_percent: 15,
  notes: "リピート注意",
};

function draft(overrides: Partial<OrderDraftItem> = {}): OrderDraftItem {
  return {
    id: "draft-1",
    productCode: "TH34486",
    quantity: 20,
    unit: "m",
    sourceType: "dimension",
    sourceLabel: "寸法計算",
    ...overrides,
  };
}

test("dimension conversion copies the final quantity without mutating its source", () => {
  const converted = createOrderDraftItem(dimensionItemToOrderDraftInput(dimensionSource), "dimension-1");
  assert.equal(converted.productCode, "TH34486");
  assert.equal(converted.quantity, 32);
  assert.equal(converted.manufacturer, "サンゲツ");
  assert.equal(converted.note, "リピート注意");

  const edited = updateOrderDraftItem([converted], converted.id, { quantity: 99 })[0];
  assert.equal(edited.quantity, 99);
  assert.equal(dimensionSource.order_quantity, 32);
});

test("area conversion supports product codes, manufacturer data, and blank product codes", () => {
  const withCode = createOrderDraftItem(
    areaResultToOrderDraftInput({ productCode: "re-55801", recommendedMeters: 223, manufacturer: "サンゲツ" }),
    "area-1",
  );
  assert.equal(withCode.productCode, "RE55801");
  assert.equal(withCode.quantity, 223);
  assert.equal(withCode.manufacturer, "サンゲツ");
  assert.equal(withCode.sourceType, "area");

  const withoutCode = createOrderDraftItem(
    areaResultToOrderDraftInput({ recommendedMeters: 18 }),
    "area-2",
  );
  assert.equal(withoutCode.productCode, "");
  assert.equal(withoutCode.quantity, 18);
});

test("manual conversion accepts blank codes and editable order fields", () => {
  const item = createOrderDraftItem(
    manualOrderDraftInput({ productCode: "", quantity: 2, unit: "本", note: "予備" }),
    "manual-1",
  );
  assert.equal(item.productCode, "");
  assert.equal(item.quantity, 2);
  assert.equal(item.unit, "本");
  assert.equal(item.note, "予備");
  assert.equal(item.sourceType, "manual");
});

test("duplicate matching normalizes product-code variations but ignores blank placeholders", () => {
  const existing = [draft({ productCode: "TH34486" })];
  assert.equal(normalizeOrderDraftProductCode(" th-34486 "), "TH34486");
  assert.equal(findDuplicateOrderDraftItem(existing, draft({ id: "new", productCode: "th-34486" }))?.id, "draft-1");
  assert.equal(findDuplicateOrderDraftItem(existing, draft({ id: "blank", productCode: "" })), undefined);
  assert.equal(findDuplicateOrderDraftItem(existing, draft({ id: "unspecified", productCode: "未指定" })), undefined);
});

test("duplicate resolution can merge, keep separate, or cancel", () => {
  const existing = draft({ quantity: 150, note: "既存", sourceLabel: "寸法計算" });
  const incoming = draft({ id: "incoming", quantity: 70, note: "今回", sourceType: "area", sourceLabel: "㎡計算" });

  const merged = mergeOrderDraftItem([existing], existing.id, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity, 220);
  assert.equal(merged[0].note, "既存 / 今回");
  assert.equal(merged[0].sourceLabel, "寸法計算 / ㎡計算");

  const separate = [existing, incoming];
  assert.equal(separate.length, 2);
  const cancelled = [existing];
  assert.deepEqual(cancelled, [existing]);
});

test("batch queue adds unique products and pauses safely at each duplicate", () => {
  const existing = draft({ productCode: "TH34486", quantity: 150 });
  const unique = draft({ id: "unique", productCode: "RE55801", quantity: 25 });
  const duplicate = draft({ id: "duplicate", productCode: "th-34486", quantity: 70 });
  const afterDuplicate = draft({ id: "after", productCode: "LW100", quantity: 12 });

  const firstPass = consumeOrderDraftQueue(
    [existing],
    [unique, duplicate, afterDuplicate],
  );
  assert.deepEqual(firstPass.items.map((item) => item.id), ["draft-1", "unique"]);
  assert.equal(firstPass.pending?.existingId, "draft-1");
  assert.equal(firstPass.pending?.incoming.id, "duplicate");
  assert.deepEqual(firstPass.remaining.map((item) => item.id), ["after"]);
  assert.equal(firstPass.addedCount, 1);

  const merged = mergeOrderDraftItem(
    firstPass.items,
    firstPass.pending!.existingId,
    firstPass.pending!.incoming,
  );
  const secondPass = consumeOrderDraftQueue(merged, firstPass.remaining);
  assert.equal(secondPass.pending, null);
  assert.deepEqual(secondPass.items.map((item) => item.id), ["draft-1", "unique", "after"]);
  assert.equal(secondPass.items[0].quantity, 220);
});

test("batch queue treats blank product codes as independent rows", () => {
  const blankOne = draft({ id: "blank-1", productCode: "", quantity: 10 });
  const blankTwo = draft({ id: "blank-2", productCode: "未指定", quantity: 20 });
  const result = consumeOrderDraftQueue([], [blankOne, blankTwo]);
  assert.equal(result.pending, null);
  assert.equal(result.items.length, 2);
  assert.equal(result.addedCount, 2);
});

test("merge refuses to add quantities with different units", () => {
  const existing = draft({ quantity: 20, unit: "m" });
  const incoming = draft({ id: "incoming", quantity: 2, unit: "本" });
  assert.equal(mergeOrderDraftItem([existing], existing.id, incoming)[0].quantity, 20);
});

test("draft fields can be edited and rows can be deleted independently", () => {
  const edited = updateOrderDraftItem([draft()], "draft-1", {
    productCode: "RE55801",
    quantity: 25.5,
    unit: "巻",
    manufacturer: "サンゲツ",
    note: "確認済み",
  });
  assert.equal(edited[0].productCode, "RE55801");
  assert.equal(edited[0].quantity, 25.5);
  assert.equal(edited[0].unit, "巻");
  assert.equal(removeOrderDraftItem(edited, "draft-1").length, 0);
});

test("copy text handles empty, single, multiple, edited, and deleted lists", () => {
  const now = new Date("2026-08-20T02:34:00Z");
  assert.equal(
    buildOrderDraftText([], "", now),
    "現場名：未入力\n日時：2026年8月20日 11:34\n\n【発注リスト】\n（品番なし）",
  );

  const first = draft({ quantity: 20 });
  assert.equal(
    buildOrderDraftText([first], "新宿マンション", now),
    "現場名：新宿マンション\n日時：2026年8月20日 11:34\n\n【発注リスト】\n・品番：TH34486 / 数量：20m",
  );

  const second = draft({ id: "draft-2", productCode: "RE55801", quantity: 25 });
  const edited = updateOrderDraftItem([first, second], "draft-1", { quantity: 23 });
  assert.match(buildOrderDraftText(edited, "現場A", now), /・品番：TH34486 \/ 数量：23m/);
  assert.match(buildOrderDraftText(edited, "現場A", now), /・品番：RE55801 \/ 数量：25m/);
  assert.doesNotMatch(buildOrderDraftText(removeOrderDraftItem(edited, "draft-2"), "現場A", now), /RE55801/);
});

test("copy text uses the legacy template while totals keep mixed units separate", () => {
  const items = [
    draft({ productCode: "", quantity: 10 }),
    draft({ id: "draft-2", productCode: "ROLL1", quantity: 2, unit: "本" }),
  ];
  assert.deepEqual(calculateOrderDraftTotals(items), [
    { unit: "m", quantity: 10 },
    { unit: "本", quantity: 2 },
  ]);
  const text = buildOrderDraftText(items, "現場B", new Date("2026-08-20T02:34:00Z"));
  assert.match(text, /現場名：現場B/);
  assert.match(text, /日時：2026年8月20日 11:34/);
  assert.match(text, /・品番：不明 \/ 数量：10m/);
  assert.match(text, /・品番：ROLL1 \/ 数量：2本/);
  assert.doesNotMatch(text, /合計：/);
});
