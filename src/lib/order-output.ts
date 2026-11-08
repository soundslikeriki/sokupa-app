/** Validate only the values being exported. Calculation/source warnings are separate. */
export function orderOutputIssue(code: unknown, quantity: unknown, rawQuantity?: unknown, unit: unknown = "m", allowZero = false): string | null {
  if (typeof code !== "string" || !code.trim() || ["未指定", "不明", "品番未入力"].includes(code.trim())) return "品番を入力してください";
  if (code.length > 160 || /\p{C}/u.test(code)) return "品番の改行・制御文字や長さを確認してください";
  if (rawQuantity !== undefined) return "発注数量の入力を完成してください";
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) return "発注数量は0以上の数値を入力してください";
  if (quantity === 0 && !allowZero) return "発注数量は0より大きい数値を入力してください";
  if (typeof unit !== "string" || !unit.trim() || /\p{C}/u.test(unit)) return "数量の単位を入力してください";
  return null;
}

export function completeOrderQuantity(raw: string, allowZero = false): boolean {
  return /^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && (allowZero ? Number(raw) >= 0 : Number(raw) > 0);
}
