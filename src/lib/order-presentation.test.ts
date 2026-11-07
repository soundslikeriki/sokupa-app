import test from "node:test";
import assert from "node:assert/strict";
import { compactReadingReviews, compactReviewReasons, shortOrderStatus } from "./order-presentation";
test("repeated global warning is presented once with every affected product retained", () => {
  const rows = compactReviewReasons([{product_code:"A",review_reasons:["原画像の訂正を確認","原画像の訂正を確認"]},{product_code:"B",review_reasons:["原画像の訂正を確認","別の確認"]}]);
  assert.deepEqual(rows,[{reason:"原画像の訂正を確認",codes:["A","B"]},{reason:"別の確認",codes:["B"]}]);
});
test("display deduplication keeps all candidate formulas and never mutates review evidence", () => {
  const original=[{reason:"訂正を確認",candidate_formulas:["2×3"],source_image_index:0},{reason:"訂正を確認",candidate_formulas:["2×3","1×4"],source_image_index:1}];
  const before=JSON.stringify(original); assert.deepEqual(compactReadingReviews(original)[0].candidate_formulas,["2×3","1×4"]);assert.equal(JSON.stringify(original),before);
});
test("compact labels keep blockers visible even when explanations are closed", () => {
  const row={orderReady:false,readingReviews:[],readingReviewConfirmed:true,incompleteMeasurements:false,incompleteSettings:false,canConfirm:true,quantityAssessment:{}};
  assert.equal(shortOrderStatus(row),"数量を確認");
  assert.equal(shortOrderStatus({...row,readingReviews:[{}],readingReviewConfirmed:false}),"訂正・取消を確認");
  assert.equal(shortOrderStatus({...row,incompleteMeasurements:true}),"入力未完了");
  assert.equal(shortOrderStatus({...row,order_mode:"pattern",canConfirm:false}),"リピート条件を確認");
  assert.equal(shortOrderStatus({...row,order_mode:"pattern",pattern_match:"other",canConfirm:false}),"職人さんに確認");
});
