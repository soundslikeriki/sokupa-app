import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAreaRequirement,
  extractWallpaperWidthCm,
  normalizeWallpaperProductCode,
} from "./area-calculation";

test("178sqm / 0.92m / 15% recommends 223m without intermediate rounding", () => {
  const result = calculateAreaRequirement(178, 0.92, 15);
  assert.ok(result);
  assert.equal(result.recommendedMeters, 223);
  assert.ok(Math.abs(result.baseMeters - 193.47826086956522) < 1e-10);
  assert.ok(Math.abs(result.metersWithLoss - 222.5) < 1e-10);
});

test("100sqm / 1.00m / 10% recommends exactly 110m", () => {
  const result = calculateAreaRequirement(100, 1, 10);
  assert.ok(result);
  assert.equal(result.baseMeters, 100);
  assert.equal(result.recommendedMeters, 110);
});

test("supports decimal area and custom width", () => {
  const result = calculateAreaRequirement(12.5, 0.925, 5);
  assert.ok(result);
  assert.equal(result.recommendedMeters, 15);
});

test("rejects zero, negative, and non-finite inputs", () => {
  assert.equal(calculateAreaRequirement(0, 0.92, 15), null);
  assert.equal(calculateAreaRequirement(-1, 0.92, 15), null);
  assert.equal(calculateAreaRequirement(10, 0, 15), null);
  assert.equal(calculateAreaRequirement(10, -0.92, 15), null);
  assert.equal(calculateAreaRequirement(Number.NaN, 0.92, 15), null);
  assert.equal(calculateAreaRequirement(10, Number.NaN, 15), null);
  assert.equal(calculateAreaRequirement(10, 0.92, Number.NaN), null);
  assert.equal(calculateAreaRequirement(10, 0.92, -1), null);
});

test("ceil uses the unrounded meters-with-loss value", () => {
  const result = calculateAreaRequirement(9.201, 0.92, 0);
  assert.ok(result);
  assert.ok(result.metersWithLoss > 10 && result.metersWithLoss < 10.01);
  assert.equal(result.recommendedMeters, 11);
});

test("extracts effective width from common Japanese specifications", () => {
  assert.equal(extractWallpaperWidthCm("巾92.5cm、防カビ"), 92.5);
  assert.equal(extractWallpaperWidthCm("有効幅：100cm"), 100);
  assert.equal(extractWallpaperWidthCm("92 cm 幅"), 92);
  assert.equal(extractWallpaperWidthCm("規格情報なし"), null);
});

test("normalizes product codes for lookup caching", () => {
  assert.equal(normalizeWallpaperProductCode(" tws-8266 "), "TWS8266");
});
