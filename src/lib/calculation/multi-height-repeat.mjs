/**
 * Verified prototype core. One product code per call; UI premises remain explicit.
 * Exact decimal arithmetic. No input mutation, order rounding, extra loss rate,
 * remnant reuse, roll allocation, or automatic confirmation of job assumptions.
 */
const SCALE = 1_000_000n;
const UNIT_SCALE = { m: SCALE, cm: 10_000n, mm: 1_000n };
const UNIT_PRECISION = { m: 6, cm: 4, mm: 3 };
const MAX_VALUE = 999_999_999_999n * SCALE + SCALE - 1n;
const KINDS = new Set(['measured', 'trim-included', 'repeat-adjusted', 'unknown']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(code, message, severity = 'review') {
  return { code, message, severity };
}

function statusOf(issues) {
  return issues.some((i) => i.severity === 'invalid') ? 'invalid' : issues.length ? 'review' : 'calculated';
}

function format(value) {
  const fraction = String(value % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

function parseLength(input, label, allowZero = false) {
  if (!object(input) || input.value === null || input.value === undefined || input.value === '') {
    return { issues: [issue('length-missing', `${label}を確認してください`)] };
  }
  if (!Object.hasOwn(UNIT_SCALE, input.unit)) {
    return { issues: [issue('unit-invalid', `${label}の単位はm・cm・mmのいずれかを明示してください`, 'invalid')] };
  }
  if ((typeof input.value !== 'string' && typeof input.value !== 'number') ||
      (typeof input.value === 'number' && !Number.isFinite(input.value))) {
    return { issues: [issue('length-invalid', `${label}は有限の数値にしてください`, 'invalid')] };
  }
  const text = String(input.value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return { issues: [issue('length-invalid', `${label}は0以上の通常の小数表記にしてください`, 'invalid')] };
  }
  const [integer, fraction = ''] = text.split('.');
  const precision = UNIT_PRECISION[input.unit];
  if (integer.length > 12 || fraction.length > precision) {
    return { issues: [issue('precision-unsupported', `${label}は整数12桁以内・${input.unit}の小数${precision}桁以内にしてください`, 'invalid')] };
  }
  const value = BigInt(integer) * UNIT_SCALE[input.unit] + BigInt(fraction.padEnd(precision, '0'));
  if ((!allowZero && value === 0n) || value > MAX_VALUE) {
    return { issues: [issue('length-range', `${label}の範囲を確認してください`, 'invalid')] };
  }
  return { value, issues: [] };
}

function parseCount(input) {
  if ((typeof input !== 'string' && typeof input !== 'number') ||
      (typeof input === 'number' && !Number.isSafeInteger(input))) {
    return { issues: [issue('count-invalid', '幅数は正の整数にしてください', 'invalid')] };
  }
  const text = String(input).trim();
  if (!/^\d{1,12}$/.test(text) || BigInt(text) === 0n) {
    return { issues: [issue('count-invalid', '幅数は1以上・12桁以内の整数にしてください', 'invalid')] };
  }
  return { value: BigInt(text), issues: [] };
}

function result(length, count, issues = []) {
  const allIssues = [...issues];
  const total = length !== null && count !== null ? length * count : null;
  if (length !== null && (length > MAX_VALUE || (total !== null && total > MAX_VALUE))) {
    allIssues.push(issue('quantity-overflow', '計算結果が対応範囲を超えています', 'invalid'));
  }
  if (allIssues.length || length === null || count === null) {
    return { status: statusOf(allIssues.length ? allIssues : [issue('calculation-incomplete', '計算条件が未確認です')]), perStripM: null, totalM: null, issues: allIssues };
  }
  return { status: 'calculated', perStripM: format(length), totalM: format(total), issues: [] };
}

function plainLength(row, source) {
  if (source === undefined) return { issues: [] };
  if (!KINDS.has(row.lengthKind)) {
    return { issues: [issue('length-kind-invalid', '寸法が実測・切り代込み・柄調整済みのどれかを確認してください', 'invalid')] };
  }
  if (row.lengthKind === 'unknown') {
    return { issues: [issue('length-basis-unconfirmed', '元の寸法に切り代や柄合わせが含まれるか未確認です')] };
  }
  if (row.lengthKind === 'repeat-adjusted') {
    return { issues: [issue('already-repeat-adjusted', '柄調整済みの寸法は再計算しません。元の実測または裁断長が必要です')] };
  }
  if (row.lengthKind === 'trim-included') {
    const issues = [];
    for (const [key, label] of [['top', '上の切り代'], ['bottom', '下の切り代']]) {
      if (row.trim?.[key] === undefined) continue;
      const parsed = parseLength(row.trim[key], label, true);
      issues.push(...parsed.issues);
      if (parsed.value !== undefined && parsed.value !== 0n) {
        issues.push(issue('double-trim', '切り代込みの寸法に追加の切り代は適用しません。入力区分を確認してください'));
      }
    }
    return { value: issues.length ? undefined : source, issues };
  }
  const top = parseLength(row.trim?.top, '上の切り代', true);
  const bottom = parseLength(row.trim?.bottom, '下の切り代', true);
  const issues = [...top.issues, ...bottom.issues];
  return { value: issues.length ? undefined : source + top.value + bottom.value, issues };
}

function calculateRow(row, index, repeat) {
  if (!object(row)) {
    const invalid = result(null, null, [issue('row-invalid', '明細が不正です', 'invalid')]);
    return { id: null, index, selectedMode: 'original', original: invalid, plain: invalid, pattern: invalid, selected: invalid };
  }
  const rowIssues = [];
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) rowIssues.push(issue('row-id-missing', '元写真と対応する明細IDが必要です', 'invalid'));
  if (row.applyRepeat !== undefined && typeof row.applyRepeat !== 'boolean') {
    rowIssues.push(issue('row-toggle-invalid', '行のリピートON/OFFはbooleanで指定してください', 'invalid'));
  }
  const source = parseLength(row.sourceLength, '元寸法');
  const count = parseCount(row.stripCount);
  const sourceIssues = [...rowIssues, ...source.issues, ...count.issues];
  const original = result(source.value ?? null, count.value ?? null, sourceIssues);
  const plain = plainLength(row, source.value);
  const plainResult = result(plain.value ?? null, count.value ?? null, [...sourceIssues, ...plain.issues]);
  const patternIssues = [...sourceIssues, ...plain.issues];
  let patternLength;
  let repeatCount;
  if (repeat.matchType !== 'straight') {
    patternIssues.push(issue('pattern-unsupported', '初期版は確認済みのストレートリピートのみ対応します。柄合わせ方法を確認してください'));
  }
  const vertical = parseLength(repeat.vertical, '縦リピート');
  patternIssues.push(...vertical.issues);
  if (!patternIssues.length && plain.value !== undefined && vertical.value !== undefined) {
    repeatCount = (plain.value + vertical.value - 1n) / vertical.value;
    patternLength = repeatCount * vertical.value;
  }
  const pattern = result(patternLength ?? null, count.value ?? null, patternIssues);
  const active = repeat.enabled === true && row.applyRepeat !== false;
  const selected = active ? pattern : original;
  return {
    id: id || null,
    index,
    lengthKind: typeof row.lengthKind === 'string' ? row.lengthKind : null,
    stripCount: count.value === undefined ? null : String(count.value),
    selectedMode: active ? 'repeat' : 'original',
    repeatCountPerStrip: pattern.status === 'calculated' ? String(repeatCount) : null,
    original,
    plain: plainResult,
    pattern,
    selected,
  };
}

function aggregate(rows, field) {
  if (!rows.length || rows.some((row) => row[field].status !== 'calculated')) return null;
  let total = 0n;
  for (const row of rows) {
    total += parseLength({ value: row[field].totalM, unit: 'm' }, '小計', true).value;
  }
  return total > MAX_VALUE ? null : format(total);
}

/**
 * rows: immutable sourceLength {value, unit}, stripCount, lengthKind, trim, id.
 * repeat.enabled: master switch. false always restores original source lengths.
 * rows[].applyRepeat=false opts one row out when the master is on.
 * plain totals include explicit cut allowance; selected OFF totals do not.
 * Calculated is arithmetic completion, NEVER confirmation that an order is safe.
 */
export function calculateMultiHeightRepeat(input) {
  const rootIssues = [];
  const validInput = object(input);
  const productCode = validInput && typeof input.productCode === 'string' ? input.productCode.trim() : '';
  if (!productCode) rootIssues.push(issue('product-code-missing', 'この計算に対応する1つの品番が必要です', 'invalid'));
  const repeat = validInput && object(input.repeat) ? input.repeat : {};
  if (typeof repeat.enabled !== 'boolean') rootIssues.push(issue('master-toggle-invalid', '全体のリピートON/OFFを明示してください', 'invalid'));
  const inputRows = validInput && Array.isArray(input.rows) ? input.rows : [];
  if (!inputRows.length) rootIssues.push(issue('rows-missing', '1行以上の寸法・幅数が必要です', 'invalid'));
  // Materialize holes so malformed sparse input is reported, not thrown by aggregation.
  const rows = Array.from(inputRows, (row, index) => calculateRow(row, index, repeat));
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) rootIssues.push(issue('duplicate-row-id', '同じ明細IDが重複しています。二重計上を防ぐため計算を確定しません', 'invalid'));
  const totals = {
    originalM: aggregate(rows, 'original'),
    plainM: aggregate(rows, 'plain'),
    patternM: aggregate(rows, 'pattern'),
    selectedM: aggregate(rows, 'selected'),
  };
  if (rows.length && rows.every((row) => row.selected.status === 'calculated') && totals.selectedM === null) {
    rootIssues.push(issue('total-overflow', '合計が対応範囲を超えています', 'invalid'));
  }
  const selectedIssues = rows.flatMap((row) => row.selected.issues.map((i) => ({ ...i, rowId: row.id })));
  const issues = [...rootIssues, ...selectedIssues];
  if (rootIssues.length) {
    for (const field of Object.keys(totals)) totals[field] = null;
  }
  return {
    schemaVersion: 1,
    productCode: productCode || null,
    status: statusOf(issues),
    rows,
    totals,
    issues,
    assumptions: {
      independentStrips: true,
      remnantReuseIncluded: false,
      rollLayoutIncluded: false,
      firstPatternAlignmentIncluded: false,
      extraReserveIncluded: false,
      orderRoundingIncluded: false,
      installationGuaranteed: false,
    },
  };
}
