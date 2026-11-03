import test from "node:test";
import assert from "node:assert/strict";
import { createWakeSignalGate } from "./wake-signal-gate";

test("warm-process burst gate bounds lookups without allowing concurrent claims", () => {
  let clock = 0;
  const gate = createWakeSignalGate(() => clock);
  assert.equal(gate.begin(), true);
  clock = 10_000; assert.equal(gate.begin(), false); // Even after cooldown, only one claim is in flight.
  gate.finish(); assert.equal(gate.begin(), true); gate.finish();
  clock = 14_999; assert.equal(gate.begin(), false);
  clock = 15_000; assert.equal(gate.begin(), true); gate.finish();
  for (let i = 0; i < 100; i++) assert.equal(gate.begin(), false);
  clock = 20_000; assert.equal(gate.begin(), true); gate.finish();
});
