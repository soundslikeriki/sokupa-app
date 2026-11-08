import { assessProductOrder } from "./product-comparison";

/** Read-only numerical comparison. Never writes acknowledgement or readiness state. */
export function numericalOrderStatus(input: {
  ordered: number; required: string | null; inputsComplete: boolean;
  conditionsKnown: boolean; measurementCertain: boolean; duplicate: boolean;
}) {
  if (!input.inputsComplete) return { state: "unknown", text: "判定不可：入力を完成してください" } as const;
  if (input.duplicate) return { state: "unknown", text: "判定不可：品番が重複しています" } as const;
  if (!input.conditionsKnown || input.required === null) return { state: "unknown", text: "判定不可：必要量の条件を確認" } as const;
  if (!input.measurementCertain) return { state: "unknown", text: "判定不可：読み取りの照合が必要" } as const;
  const result = assessProductOrder(input.ordered, input.required, true);
  if (result.status === "sufficient") return { state: "sufficient", text: `入力値上は必要量以上（必要 ${input.required}m）` } as const;
  if (result.status === "shortfall") return { state: "shortfall", text: `${result.shortage}m不足（必要 ${input.required}m）` } as const;
  return { state: "unknown", text: "判定不可：必要量を確認" } as const;
}
