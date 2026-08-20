export const STANDARD_WALLPAPER_WIDTH_CM = 92;
export const WIDE_WALLPAPER_WIDTH_CM = 100;

export type AreaCalculationResult = {
  areaSqm: number;
  widthMeters: number;
  baseMeters: number;
  lossPercent: number;
  metersWithLoss: number;
  recommendedMeters: number;
};

export function calculateAreaRequirement(
  areaSqm: number,
  widthMeters: number,
  lossPercent: number,
): AreaCalculationResult | null {
  if (
    !Number.isFinite(areaSqm) ||
    !Number.isFinite(widthMeters) ||
    !Number.isFinite(lossPercent) ||
    areaSqm <= 0 ||
    widthMeters <= 0 ||
    lossPercent < 0
  ) {
    return null;
  }

  const baseMeters = areaSqm / widthMeters;
  const metersWithLoss = baseMeters * (1 + lossPercent / 100);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(metersWithLoss)) * 4;

  return {
    areaSqm,
    widthMeters,
    baseMeters,
    lossPercent,
    metersWithLoss,
    recommendedMeters: Math.ceil(metersWithLoss - floatingPointTolerance),
  };
}

export function extractWallpaperWidthCm(spec: unknown): number | null {
  const text = String(spec ?? "").replace(/,/g, ".").trim();
  const match =
    /(?:有効\s*)?(?:巾|幅)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*cm/i.exec(text) ||
    /(\d+(?:\.\d+)?)\s*cm\s*(?:有効\s*)?(?:巾|幅)/i.exec(text);
  const widthCm = match ? Number(match[1]) : NaN;
  return Number.isFinite(widthCm) && widthCm > 0 ? widthCm : null;
}

export function normalizeWallpaperProductCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s\-]+/g, "");
}
