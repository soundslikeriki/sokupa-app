import assert from "node:assert/strict";
import test from "node:test";

import {
  areAllCodesCollapsed,
  pruneCollapsedCodes,
  toggleAllCollapsedCodes,
  toggleCollapsedCode,
} from "./collapse-state";

test("toggles one product without changing other products", () => {
  const first = toggleCollapsedCode(new Set<string>(), "TH32661");
  assert.deepEqual(Array.from(first), ["TH32661"]);
  assert.deepEqual(Array.from(toggleCollapsedCode(first, "TH32661")), []);
});

test("bulk toggle collapses all, expands all, and handles mixed state", () => {
  const codes = ["TH32661", "SGP1557"];
  const all = toggleAllCollapsedCodes(new Set(), codes);
  assert.equal(areAllCodesCollapsed(all, codes), true);
  assert.deepEqual(Array.from(toggleAllCollapsedCodes(all, codes)), []);

  const mixed = new Set(["TH32661"]);
  assert.deepEqual(Array.from(toggleAllCollapsedCodes(mixed, codes)).sort(), [...codes].sort());
});

test("prunes keys after items reset or product code edit", () => {
  const current = new Set(["OLD100", "KEEP200"]);
  assert.deepEqual(Array.from(pruneCollapsedCodes(current, ["KEEP200", "NEW100"])), ["KEEP200"]);
  assert.deepEqual(Array.from(pruneCollapsedCodes(current, [])), []);
});
