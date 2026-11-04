import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOrderQuantity as assess, adjustOrderQuantity as adjust } from './order-quantity.mjs';

// Unintegrated and unpublished prototype; numerical comparison is not an installation guarantee.
const base = Object.freeze({ orderedQuantity: '10', requiredQuantity: '10', orderedUnit: 'm', requiredUnit: 'm', assumptionsConfirmed: true });

test('confirmed equality and excess pass; shortage is exact', () => {
  for (const orderedQuantity of ['10', '10.1', 10]) assert.equal(assess({ ...base, orderedQuantity }).showCheckmark, true);
  assert.equal(assess({ ...base, orderedQuantity: '9.9' }).shortage, '0.1');
  assert.equal(assess({ ...base, orderedQuantity: '9.9' }).status, 'shortfall');
});
test('unconfirmed premises never show a check even above required quantity', () => {
  for (const assumptionsConfirmed of [false, undefined, null, 'true', 1, {}]) {
    for (const orderedQuantity of ['9', '10', '11']) {
      const result = assess({ ...base, orderedQuantity, assumptionsConfirmed });
      assert.equal(result.status, 'review');
      assert.equal(result.showCheckmark, false);
    }
  }
});
test('invalid and absent values fail closed on either quantity', () => {
  for (const value of ['', ' ', null, undefined, NaN, Infinity, -Infinity, -1, '-1', 'abc', '1,000', '1e2', true, {}, [], '1.0000001', 0.1 + 0.2, '1000000000000']) {
    for (const field of ['orderedQuantity', 'requiredQuantity']) {
      const result = assess({ ...base, [field]: value });
      assert.equal(result.status, 'invalid', `${field}=${String(value)}`);
      assert.equal(result.showCheckmark, false);
    }
  }
  for (const value of [null, undefined, false]) assert.equal(assess(value).status, 'invalid');
});
test('units must be explicit and equal; no implicit m/cm conversion', () => {
  for (const changes of [{ orderedUnit: 'cm' }, { requiredUnit: '' }, { orderedUnit: null }, { requiredUnit: undefined }]) {
    assert.equal(assess({ ...base, ...changes }).status, 'invalid');
  }
  assert.equal(assess({ ...base, orderedUnit: ' m ' }).status, 'sufficient');
});
test('zero requirement remains review; zero ordered quantity may be a shortage', () => {
  for (const orderedQuantity of ['0', '10']) {
    assert.equal(assess({ ...base, orderedQuantity, requiredQuantity: '0' }).status, 'review');
    assert.equal(assess({ ...base, orderedQuantity, requiredQuantity: '0' }).showCheckmark, false);
  }
  assert.equal(assess({ ...base, orderedQuantity: '0' }).shortage, '10');
});
test('decimal boundaries use exact comparison without epsilon or false green', () => {
  assert.equal(assess({ ...base, orderedQuantity: '0.299999', requiredQuantity: '0.3' }).shortage, '0.000001');
  assert.equal(assess({ ...base, orderedQuantity: '0.300000', requiredQuantity: 0.3 }).status, 'sufficient');
  assert.equal(assess({ ...base, orderedQuantity: '999999999999.999998', requiredQuantity: '999999999999.999999' }).shortage, '0.000001');
});
test('plus/minus recalculate exactly without mutating input', () => {
  const input = Object.freeze({ ...base, orderedQuantity: '0.2', requiredQuantity: '0.3' });
  const plus = adjust(input, '+', '0.1');
  assert.equal(plus.nextOrderedQuantity, '0.3');
  assert.equal(plus.assessment.status, 'sufficient');
  const minus = adjust({ ...input, orderedQuantity: plus.nextOrderedQuantity }, '-', '0.1');
  assert.equal(minus.nextOrderedQuantity, '0.2');
  assert.equal(minus.assessment.shortage, '0.1');
  assert.equal(input.orderedQuantity, '0.2');
  assert.equal(adjust({ ...input, assumptionsConfirmed: false }, '+', '0.1').assessment.showCheckmark, false);
});
test('invalid adjustment, negative result and overflow fail without new quantity', () => {
  for (const [input, direction, step] of [[base, '*', '1'], [base, '+', '0'], [base, '+', -1], [base, '+', NaN], [base, '-', '11'], [null, '+', '1'], [{ ...base, orderedQuantity: '999999999999' }, '+', '1']]) {
    const result = adjust(input, direction, step);
    assert.equal(result.nextOrderedQuantity, null);
    assert.equal(result.assessment.status, 'invalid');
  }
});

test('default adjustment is one unit, matching the legacy 1m controls', () => {
  assert.equal(adjust(base, '+').nextOrderedQuantity, '11');
  const minus = adjust(base, '-');
  assert.equal(minus.nextOrderedQuantity, '9');
  assert.equal(minus.assessment.shortage, '1');
});
