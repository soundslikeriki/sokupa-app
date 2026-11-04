/** Exact numerical core; a numerical check is not an installation guarantee. */
const SCALE = 1_000_000n;
const MAX_INTEGER_DIGITS = 12;

// Exact decimal arithmetic: no tolerance that could turn a small shortage into a pass.
// Strings are preferred. Floating-point artifacts and precision > 6 places fail closed.
function parseQuantity(value) {
  if (value === null || value === undefined || value === '') return { error: '未入力です' };
  if (typeof value !== 'string' && typeof value !== 'number') return { error: '数値を入力してください' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { error: '有限の数値を入力してください' };
  const text = String(value).trim();
  if (!text) return { error: '未入力です' };
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { error: '0以上の通常の小数表記で入力してください' };
  const [integer, fraction = ''] = text.split('.');
  if (integer.length > MAX_INTEGER_DIGITS || fraction.length > 6) {
    return { error: '整数12桁以内・小数6桁以内で入力してください' };
  }
  return { value: BigInt(integer) * SCALE + BigInt(fraction.padEnd(6, '0')) };
}

function format(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${sign}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}

function invalid(message) {
  return { status: 'invalid', showCheckmark: false, message: `要確認：${message}`, shortage: null };
}

/**
 * Input: orderedQuantity, requiredQuantity (decimal strings preferred),
 * orderedUnit, requiredUnit (explicit, equal units; no automatic conversion),
 * assumptionsConfirmed (strict boolean true only after required-quantity premises are verified).
 * Result shortage is an exact decimal string or null, in the input unit.
 */
export function assessOrderQuantity(input = {}) {
  if (!input || typeof input !== 'object') return invalid('数量情報がありません');
  const ordered = parseQuantity(input.orderedQuantity);
  const required = parseQuantity(input.requiredQuantity);
  if (ordered.error) return invalid(`発注数量：${ordered.error}`);
  if (required.error) return invalid(`必要数量：${required.error}`);
  const orderedUnit = typeof input.orderedUnit === 'string' ? input.orderedUnit.trim() : '';
  const requiredUnit = typeof input.requiredUnit === 'string' ? input.requiredUnit.trim() : '';
  if (!orderedUnit || !requiredUnit || orderedUnit !== requiredUnit) {
    return invalid('発注数量と必要数量の単位を確認してください（自動換算はしません）');
  }
  const shortage = required.value > ordered.value ? format(required.value - ordered.value) : '0';
  if (required.value === 0n) {
    return { status: 'review', showCheckmark: false, shortage, unit: orderedUnit,
      message: '要確認：必要数量が0です。必要量の算出条件を確認してください' };
  }
  if (input.assumptionsConfirmed !== true) {
    return { status: 'review', showCheckmark: false, shortage, unit: orderedUnit,
      message: `要確認：柄リピート・切り代など、必要量の算出条件が未確認です${shortage !== '0' ? `（入力値の比較では${shortage}${orderedUnit}不足）` : ''}` };
  }
  if (shortage !== '0') {
    return { status: 'shortfall', showCheckmark: false, shortage, unit: orderedUnit,
      message: `不足：あと${shortage}${orderedUnit}必要です（入力値の比較）` };
  }
  return { status: 'sufficient', showCheckmark: true, shortage, unit: orderedUnit,
    message: '✅ 必要量以上です（確認済みの算出条件・入力値による比較）' };
}

/** Pure +/- recalculation. No input mutation, rounding, clamping, or stored confirmation changes. */
export function adjustOrderQuantity(input, direction, step = '1') {
  if (!input || typeof input !== 'object') return { nextOrderedQuantity: null, assessment: invalid('数量情報がありません') };
  const current = parseQuantity(input.orderedQuantity);
  const delta = parseQuantity(step);
  if ((direction !== '+' && direction !== '-') || current.error || delta.error || delta.value === 0n) {
    return { nextOrderedQuantity: null, assessment: invalid('調整方向・現在数量・0より大きい調整幅を確認してください') };
  }
  const next = current.value + (direction === '+' ? delta.value : -delta.value);
  if (next < 0n) return { nextOrderedQuantity: null, assessment: invalid('発注数量を0未満にはできません') };
  const nextOrderedQuantity = format(next);
  const assessment = assessOrderQuantity({ ...input, orderedQuantity: nextOrderedQuantity });
  if (assessment.status === 'invalid' && parseQuantity(nextOrderedQuantity).error) {
    return { nextOrderedQuantity: null, assessment };
  }
  return { nextOrderedQuantity, assessment };
}
