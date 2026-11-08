import test from "node:test";
import assert from "node:assert/strict";
import { orderOutputIssue, completeOrderQuantity } from "./order-output";
import { buildOrderRequestText } from "./order-text";

test("output validates chosen values independently from calculation and reading warnings", () => {
  for (const quantity of [1, 23, 50, 51, 0.5]) {
    assert.equal(orderOutputIssue("SYN", quantity), null);
    assert.match(buildOrderRequestText([{ product_code: "SYN", order_quantity: quantity, total_m: 99, needs_review: true }], "A"), new RegExp(`数量：${quantity}m`));
  }
  for (const quantity of [undefined, null, "23", NaN, Infinity, -1, 0]) assert.ok(orderOutputIssue("SYN", quantity));
  assert.equal(orderOutputIssue("SYN", 0, undefined, "m", true), null, "retain existing draft explicit zero without extending memo zero policy");
  assert.throws(() => buildOrderRequestText([{ product_code: "SYN", order_quantity: 0, total_m: 99 }], "A"));
  for (const code of ["", " ", "不明", "A\nB", "A\u200BB"]) assert.ok(orderOutputIssue(code, 23));
  for (const raw of ["", "NaN", "-1", "1."]) assert.ok(orderOutputIssue("SYN", 23, raw));
  assert.equal(completeOrderQuantity(""), false); assert.equal(completeOrderQuantity("0"), false);
  assert.equal(completeOrderQuantity("0", true), true); assert.equal(completeOrderQuantity("23"), true);
});
