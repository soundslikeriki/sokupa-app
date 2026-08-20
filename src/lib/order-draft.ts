import type {
  MemoProductItem,
  OrderDraftItem,
  OrderDraftItemInput,
  OrderDraftSourceType,
} from "@/types";

const SOURCE_LABELS: Record<OrderDraftSourceType, string> = {
  dimension: "寸法計算",
  area: "㎡計算",
  manual: "手動",
};

const EMPTY_PRODUCT_CODES = new Set(["", "未指定", "不明", "品番未入力"]);

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text && text !== "不明" && text !== "情報なし" ? text : undefined;
}

function sanitizeQuantity(value: unknown): number {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) return 0;
  return Number(quantity.toFixed(2));
}

export function normalizeOrderDraftProductCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s\-]+/g, "");
  return EMPTY_PRODUCT_CODES.has(normalized) ? "" : normalized;
}

export function createOrderDraftItem(input: OrderDraftItemInput, id: string): OrderDraftItem {
  return {
    ...input,
    id,
    productCode: normalizeOrderDraftProductCode(input.productCode),
    quantity: sanitizeQuantity(input.quantity),
    unit: String(input.unit || "m").trim() || "m",
    manufacturer: optionalText(input.manufacturer),
    note: optionalText(input.note),
    sourceLabel: optionalText(input.sourceLabel) || SOURCE_LABELS[input.sourceType],
    sourceRef: optionalText(input.sourceRef),
  };
}

export function dimensionItemToOrderDraftInput(item: MemoProductItem): OrderDraftItemInput {
  return {
    productCode: item.product_code,
    quantity: sanitizeQuantity(item.order_quantity),
    unit: "m",
    manufacturer: optionalText(item.manufacturer),
    note: optionalText(item.notes),
    sourceType: "dimension",
    sourceLabel: SOURCE_LABELS.dimension,
    sourceRef: item.product_code,
  };
}

export function areaResultToOrderDraftInput(input: {
  productCode?: string;
  recommendedMeters: number;
  manufacturer?: string;
  note?: string;
}): OrderDraftItemInput {
  return {
    productCode: input.productCode || "",
    quantity: sanitizeQuantity(input.recommendedMeters),
    unit: "m",
    manufacturer: optionalText(input.manufacturer),
    note: optionalText(input.note),
    sourceType: "area",
    sourceLabel: SOURCE_LABELS.area,
    sourceRef: normalizeOrderDraftProductCode(input.productCode),
  };
}

export function manualOrderDraftInput(input: {
  productCode?: string;
  quantity: number;
  unit?: string;
  manufacturer?: string;
  note?: string;
}): OrderDraftItemInput {
  return {
    productCode: input.productCode || "",
    quantity: sanitizeQuantity(input.quantity),
    unit: input.unit || "m",
    manufacturer: optionalText(input.manufacturer),
    note: optionalText(input.note),
    sourceType: "manual",
    sourceLabel: SOURCE_LABELS.manual,
  };
}

export function findDuplicateOrderDraftItem(
  items: readonly OrderDraftItem[],
  incoming: OrderDraftItem,
): OrderDraftItem | undefined {
  const normalized = normalizeOrderDraftProductCode(incoming.productCode);
  if (!normalized) return undefined;
  return items.find((item) => normalizeOrderDraftProductCode(item.productCode) === normalized);
}

function combineText(first?: string, second?: string): string | undefined {
  const values = [optionalText(first), optionalText(second)].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );
  return values.length > 0 ? values.join(" / ") : undefined;
}

export function mergeOrderDraftItem(
  items: readonly OrderDraftItem[],
  existingId: string,
  incoming: OrderDraftItem,
): OrderDraftItem[] {
  return items.map((item) => {
    if (item.id !== existingId || item.unit !== incoming.unit) return item;
    return {
      ...item,
      quantity: sanitizeQuantity(item.quantity + incoming.quantity),
      manufacturer: item.manufacturer || incoming.manufacturer,
      note: combineText(item.note, incoming.note),
      sourceLabel: combineText(item.sourceLabel, incoming.sourceLabel) || item.sourceLabel,
    };
  });
}

export function updateOrderDraftItem(
  items: readonly OrderDraftItem[],
  id: string,
  patch: Partial<Pick<OrderDraftItem, "productCode" | "quantity" | "unit" | "manufacturer" | "note">>,
): OrderDraftItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    return {
      ...item,
      ...patch,
      quantity: patch.quantity === undefined ? item.quantity : sanitizeQuantity(patch.quantity),
      unit: patch.unit === undefined ? item.unit : String(patch.unit).trim() || "m",
      manufacturer:
        patch.manufacturer === undefined ? item.manufacturer : optionalText(patch.manufacturer),
      note: patch.note === undefined ? item.note : optionalText(patch.note),
    };
  });
}

export function removeOrderDraftItem(items: readonly OrderDraftItem[], id: string): OrderDraftItem[] {
  return items.filter((item) => item.id !== id);
}

export type OrderDraftTotal = {
  unit: string;
  quantity: number;
};

export function calculateOrderDraftTotals(items: readonly OrderDraftItem[]): OrderDraftTotal[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    const unit = item.unit.trim() || "m";
    totals.set(unit, sanitizeQuantity((totals.get(unit) ?? 0) + item.quantity));
  }
  return Array.from(totals, ([unit, quantity]) => ({ unit, quantity }));
}

export function formatOrderDraftQuantity(value: number): string {
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

export function buildOrderDraftText(items: readonly OrderDraftItem[]): string {
  const lines = ["【発注リスト】", ""];
  if (items.length === 0) {
    lines.push("（材料なし）");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(
      `・${item.productCode || "品番未入力"} / ${formatOrderDraftQuantity(item.quantity)}${item.unit}`,
    );
  }

  lines.push("");
  const totals = calculateOrderDraftTotals(items);
  totals.forEach((total, index) => {
    const label = index === 0 ? "合計" : "　　";
    lines.push(`${label}：${formatOrderDraftQuantity(total.quantity)}${total.unit}`);
  });
  return lines.join("\n");
}
