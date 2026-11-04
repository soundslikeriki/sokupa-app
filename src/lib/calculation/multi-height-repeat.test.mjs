import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMultiHeightRepeat as calculate } from './multi-height-repeat.mjs';

const length = (value, unit = 'm') => ({ value, unit });
const row = (changes = {}) => ({
  id: 'wall-a', sourceLength: length('2.4'), stripCount: 2,
  lengthKind: 'measured', trim: { top: length('5', 'cm'), bottom: length('50', 'mm') },
  ...changes,
});
const input = (changes = {}) => ({
  productCode: 'TEST-001', repeat: { enabled: true, matchType: 'straight', vertical: length('0.6') },
  rows: [row()], ...changes,
});
const codes = (result) => result.issues.map((i) => i.code);
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};

test('multiple heights round each strip independently before summing', () => {
  const out = calculate(input({ rows: [row(), row({ id: 'wall-b', sourceLength: length('2.9'), stripCount: 3 })] }));
  assert.equal(out.status, 'calculated');
  assert.deepEqual(out.totals, { originalM: '13.5', plainM: '14', patternM: '15', selectedM: '15' });
  assert.deepEqual(out.rows.map((r) => r.repeatCountPerStrip), ['5', '5']);
});

test('master OFF restores source, explicitly excluding added cut allowance', () => {
  const out = calculate(input({ repeat: { enabled: false, matchType: 'straight', vertical: length('0.6') } }));
  assert.equal(out.totals.selectedM, '4.8');
  assert.equal(out.totals.plainM, '5');
  assert.equal(out.totals.patternM, '6');
  assert.equal(out.rows[0].selectedMode, 'original');
});

test('row opt-out restores original while other rows use repeat', () => {
  const out = calculate(input({ rows: [row({ applyRepeat: false }), row({ id: 'b' })] }));
  assert.equal(out.totals.selectedM, '10.8');
  assert.deepEqual(out.rows.map((r) => r.selectedMode), ['original', 'repeat']);
});

test('OFF/ON/OFF recalculations do not mutate or accumulate allowances', () => {
  const original = deepFreeze(input());
  const before = JSON.stringify(original);
  const on = calculate(original);
  const offInput = { ...original, repeat: { ...original.repeat, enabled: false } };
  assert.deepEqual(calculate(offInput), calculate(offInput));
  assert.deepEqual(calculate(original), on);
  assert.equal(JSON.stringify(original), before);
  assert.equal(calculate(offInput).totals.selectedM, '4.8');
});

test('exact repeat multiple is not rounded up again', () => {
  const out = calculate(input({ rows: [row({ sourceLength: length('2.3') })] }));
  assert.equal(out.rows[0].pattern.perStripM, '2.4');
  assert.equal(out.rows[0].repeatCountPerStrip, '4');
});

test('one micrometre past a repeat multiple rounds to the next repeat', () => {
  const out = calculate(input({ rows: [row({ sourceLength: length('2.300001') })] }));
  assert.equal(out.rows[0].pattern.perStripM, '3');
});

test('m/cm/mm convert exactly, including smallest supported increments', () => {
  for (const sourceLength of [length('0.000001'), length('0.0001', 'cm'), length('0.001', 'mm')]) {
    const out = calculate(input({ rows: [row({ sourceLength, stripCount: 3, trim: { top: length(0), bottom: length(0) } })], repeat: { enabled: true, matchType: 'straight', vertical: length('0.000001') } }));
    assert.equal(out.totals.selectedM, '0.000003');
  }
});

test('ordinary finite numeric inputs and padded strings are supported', () => {
  const out = calculate(input({ rows: [row({ sourceLength: length(2.4), stripCount: ' 2 ' })] }));
  assert.equal(out.totals.selectedM, '6');
});

test('trim-included dimensions are used once without explicit extra trim', () => {
  const out = calculate(input({ rows: [row({ sourceLength: length('2.5'), lengthKind: 'trim-included', trim: undefined })] }));
  assert.equal(out.rows[0].plain.perStripM, '2.5');
  assert.equal(out.totals.selectedM, '6');
});

test('trim-included accepts explicitly zero extra trim', () => {
  assert.equal(calculate(input({ rows: [row({ lengthKind: 'trim-included', trim: { top: length(0), bottom: length(0) } })] })).status, 'calculated');
});

for (const [name, changes, expected] of [
  ['double cut allowance', { lengthKind: 'trim-included' }, 'double-trim'],
  ['unknown dimension basis', { lengthKind: 'unknown' }, 'length-basis-unconfirmed'],
  ['already adjusted dimension', { lengthKind: 'repeat-adjusted' }, 'already-repeat-adjusted'],
  ['missing upper allowance', { trim: { bottom: length(0) } }, 'length-missing'],
  ['missing lower allowance', { trim: { top: length(0) } }, 'length-missing'],
]) {
  test(`${name} requires review rather than an estimate`, () => {
    const out = calculate(input({ rows: [row(changes)] }));
    assert.equal(out.status, 'review');
    assert.equal(out.totals.selectedM, null);
    assert.ok(codes(out).includes(expected));
  });
}

test('OFF remains original even when repeat and allowance details are missing', () => {
  const out = calculate(input({ repeat: { enabled: false }, rows: [row({ trim: undefined, lengthKind: 'unknown' })] }));
  assert.equal(out.status, 'calculated');
  assert.equal(out.totals.selectedM, '4.8');
  assert.equal(out.rows[0].pattern.status, 'review');
});

for (const matchType of ['half-drop', 'random', undefined]) {
  test(`unsupported match ${matchType} does not calculate pattern`, () => {
    const out = calculate(input({ repeat: { enabled: true, matchType, vertical: length('0.6') } }));
    assert.equal(out.status, 'review');
    assert.ok(codes(out).includes('pattern-unsupported'));
    assert.equal(out.totals.selectedM, null);
  });
}

for (const sourceLength of [length(-1), length(0), length(Infinity), length(NaN), length('1e3'), length('1,000'), length('0.0000001'), length('1.00001', 'cm'), length('1.0001', 'mm'), length('1000000000000'), length('1', 'ft'), length(true)]) {
  test(`reject invalid length ${JSON.stringify(sourceLength)}`, () => {
    const out = calculate(input({ rows: [row({ sourceLength })] }));
    assert.equal(out.status, 'invalid');
    assert.equal(out.totals.selectedM, null);
  });
}

for (const stripCount of [0, -1, 1.5, NaN, Infinity, '', '1e2', '1000000000000', Number.MAX_SAFE_INTEGER + 1, null]) {
  test(`reject invalid count ${String(stripCount)}`, () => {
    const out = calculate(input({ rows: [row({ stripCount })] }));
    assert.equal(out.status, 'invalid');
    assert.ok(codes(out).includes('count-invalid'));
  });
}

for (const malformed of [null, {}, [], { productCode: 'x', repeat: { enabled: false }, rows: [] }]) {
  test(`malformed root ${JSON.stringify(malformed)} returns validation result`, () => {
    assert.equal(calculate(malformed).status, 'invalid');
  });
}

test('sparse rows return invalid instead of throwing', () => {
  for (const rows of [new Array(1), [row(), , row({ id: 'b' })]]) {
    const out = calculate(input({ rows }));
    assert.equal(out.status, 'invalid');
    assert.ok(codes(out).includes('row-invalid'));
    assert.equal(out.totals.selectedM, null);
  }
});

test('null and primitive rows return invalid', () => {
  for (const invalidRow of [null, undefined, 1, 'row', []]) {
    assert.equal(calculate(input({ rows: [invalidRow] })).status, 'invalid');
  }
});

test('missing IDs, invalid basis and row toggles are rejected', () => {
  for (const changes of [{ id: '' }, { id: 1 }, { applyRepeat: 'false' }, { lengthKind: 'other' }]) {
    assert.equal(calculate(input({ rows: [row(changes)] })).status, 'invalid');
  }
});

test('duplicate trimmed IDs invalidate all aggregate totals', () => {
  const out = calculate(input({ rows: [row(), row({ id: ' wall-a ' })] }));
  assert.ok(codes(out).includes('duplicate-row-id'));
  assert.deepEqual(Object.values(out.totals), [null, null, null, null]);
});

test('master switch must be explicit boolean and product must be present', () => {
  for (const changes of [{ repeat: {} }, { repeat: { enabled: 'false' } }, { productCode: ' ' }]) {
    const out = calculate(input(changes));
    assert.equal(out.status, 'invalid');
    assert.deepEqual(Object.values(out.totals), [null, null, null, null]);
  }
});

test('zero vertical repeat is invalid, not division by zero', () => {
  const out = calculate(input({ repeat: { enabled: true, matchType: 'straight', vertical: length(0) } }));
  assert.equal(out.status, 'invalid');
  assert.ok(codes(out).includes('length-range'));
});

test('maximum exact quantity is accepted when OFF', () => {
  const out = calculate(input({ repeat: { enabled: false }, rows: [row({ sourceLength: length('999999999999.999999'), stripCount: 1 })] }));
  assert.equal(out.totals.selectedM, '999999999999.999999');
});

test('row quantity overflow is invalid and suppresses the selected total', () => {
  const out = calculate(input({ repeat: { enabled: false }, rows: [row({ sourceLength: length('999999999999'), stripCount: 2 })] }));
  assert.equal(out.status, 'invalid');
  assert.ok(codes(out).includes('quantity-overflow'));
  assert.equal(out.totals.selectedM, null);
});

test('sum overflow across otherwise valid rows invalidates aggregate totals', () => {
  const out = calculate(input({ repeat: { enabled: false }, rows: [row({ sourceLength: length('600000000000'), stripCount: 1 }), row({ id: 'b', sourceLength: length('600000000000'), stripCount: 1 })] }));
  assert.ok(codes(out).includes('total-overflow'));
  assert.deepEqual(Object.values(out.totals), [null, null, null, null]);
});

test('nonselected comparison overflow does not invalidate OFF source result', () => {
  const out = calculate(input({ repeat: { enabled: false, matchType: 'straight', vertical: length('999999999999') }, rows: [row({ sourceLength: length('999999999999'), stripCount: 1 })] }));
  assert.equal(out.status, 'calculated');
  assert.equal(out.totals.patternM, null);
  assert.equal(out.rows[0].pattern.status, 'invalid');
});

test('assumptions make omitted installation and ordering work explicit', () => {
  assert.deepEqual(calculate(input()).assumptions, {
    independentStrips: true, remnantReuseIncluded: false, rollLayoutIncluded: false,
    firstPatternAlignmentIncluded: false, extraReserveIncluded: false,
    orderRoundingIncluded: false, installationGuaranteed: false,
  });
});

test('200 deterministic heights satisfy integer-mm reference ceiling arithmetic', () => {
  for (let i = 1; i <= 200; i++) {
    const sourceMm = 1700 + 7 * i;
    const topMm = i % 11;
    const bottomMm = i % 17;
    const repeatMm = 100 + (i % 9) * 37;
    const count = 1 + i % 5;
    const expectedMm = Math.ceil((sourceMm + topMm + bottomMm) / repeatMm) * repeatMm;
    const out = calculate(input({
      rows: [row({ sourceLength: length(sourceMm, 'mm'), stripCount: count,
        trim: { top: length(topMm, 'mm'), bottom: length(bottomMm, 'mm') } })],
      repeat: { enabled: true, matchType: 'straight', vertical: length(repeatMm, 'mm') },
    }));
    assert.equal(out.rows[0].pattern.perStripM, String(expectedMm / 1000));
    assert.equal(out.totals.selectedM, String(expectedMm * count / 1000));
  }
});
