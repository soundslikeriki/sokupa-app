function validCodes(productCodes: readonly string[]): Set<string> {
  return new Set(productCodes.map((code) => code.trim()).filter(Boolean));
}

export function toggleCollapsedCode(current: ReadonlySet<string>, productCode: string): Set<string> {
  const next = new Set(current);
  if (next.has(productCode)) next.delete(productCode);
  else next.add(productCode);
  return next;
}

export function pruneCollapsedCodes(
  current: ReadonlySet<string>,
  productCodes: readonly string[],
): Set<string> {
  const allowed = validCodes(productCodes);
  return new Set(Array.from(current).filter((code) => allowed.has(code)));
}

export function areAllCodesCollapsed(
  current: ReadonlySet<string>,
  productCodes: readonly string[],
): boolean {
  const codes = Array.from(validCodes(productCodes));
  return codes.length > 0 && codes.every((code) => current.has(code));
}

export function toggleAllCollapsedCodes(
  current: ReadonlySet<string>,
  productCodes: readonly string[],
): Set<string> {
  const codes = Array.from(validCodes(productCodes));
  return areAllCodesCollapsed(current, codes) ? new Set() : new Set(codes);
}
