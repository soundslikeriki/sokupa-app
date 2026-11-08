import test from "node:test";
import assert from "node:assert/strict";
import { compactReadingReviews, compactReviewReasons, concreteReadingReason, readingEvidenceGroups, shortOrderStatus } from "./order-presentation";
test("repeated global warning is presented once with every affected product retained", () => {
  const rows = compactReviewReasons([{product_code:"A",review_reasons:["原画像の訂正を確認","原画像の訂正を確認"]},{product_code:"B",review_reasons:["原画像の訂正を確認","別の確認"]}]);
  assert.deepEqual(rows,[{reason:"原画像の訂正を確認",codes:["A","B"]}]);
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

test("generic catalog/image advice is hidden without mutating underlying reading flags", () => {
  const item = {product_code:"A",needs_review:true,review_reasons:["商品情報：カタログ情報を確認してください","画像：解析結果を原画像で確認してください","画像：不鮮明で数字を読み取れません","品番：THの末尾が読めない"]};
  const before=JSON.stringify(item), rows=compactReviewReasons([item]);
  assert.deepEqual(rows.map(row=>row.reason),item.review_reasons.slice(2));assert.equal(JSON.stringify(item),before);assert.equal(item.needs_review,true);
  assert.equal(concreteReadingReason("予備分を確認"),false);assert.equal(concreteReadingReason("訂正後の3×4を採用しました"),true);
});
test("identical evidence is shown once with exact affected products, never shared acknowledgement or guessed scope", () => {
  const shared={reason:"Bの3×4は取消候補",candidate_formulas:["3×4"],source_image_index:0};
  const rows=[{code:"A",reviews:[shared]},{code:"B",reviews:[shared,{reason:"品番を書き直した",candidate_formulas:[],source_image_index:0}]}];
  const before=JSON.stringify(rows), groups=readingEvidenceGroups(rows);
  assert.equal(groups.length,2);assert.deepEqual(groups[0].codes,["A","B"]);assert.deepEqual(groups[1].codes,["B"]);assert.equal(JSON.stringify(rows),before);
  assert.equal(readingEvidenceGroups([{code:"A",reviews:[shared]},{code:"B",reviews:[{...shared,source_image_index:1}]}]).length,2);
});
