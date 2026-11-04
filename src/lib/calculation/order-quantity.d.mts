export type QuantityInput = { orderedQuantity?: unknown; requiredQuantity?: unknown; orderedUnit?: unknown; requiredUnit?: unknown; assumptionsConfirmed?: unknown };
export type QuantityAssessment = { status: "invalid" | "review" | "shortfall" | "sufficient"; showCheckmark: boolean; message: string; shortage: string | null; unit?: string };
export function assessOrderQuantity(input?: QuantityInput | null): QuantityAssessment;
export function adjustOrderQuantity(input: QuantityInput | null, direction: "+" | "-", step?: string | number): { nextOrderedQuantity: string | null; assessment: QuantityAssessment };
