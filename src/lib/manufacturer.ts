import type { ManufacturerId } from "@/types";

const rules: { id: ManufacturerId; patterns: RegExp[] }[] = [
  {
    id: "sangetsu",
    patterns: [/^BB\d{4,}/i, /^SP\d{4,}/i, /^TH\d{4,}/i],
  },
  {
    id: "lilycolor",
    patterns: [/^LL\d{4,}/i, /^LC\d{4,}/i],
  },
  {
    id: "sincol",
    patterns: [/^SH\d{4,}/i, /^SI\d{4,}/i],
  },
  {
    id: "toli",
    patterns: [/^F\d{3,}/i, /^TOLI-/i],
  },
];

export function getManufacturerFromPartNumber(partNumber: string): ManufacturerId {
  const normalized = partNumber.trim().toUpperCase();
  for (const rule of rules) {
    if (rule.patterns.some((re) => re.test(normalized))) {
      return rule.id;
    }
  }
  return "other";
}

export const manufacturerLabels: Record<ManufacturerId, string> = {
  sangetsu: "サンゲツ",
  lilycolor: "リリカラ",
  sincol: "シンコール",
  toli: "東リ",
  other: "その他",
};
