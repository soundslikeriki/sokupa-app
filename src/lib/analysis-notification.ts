import type { ParsedMemoPayload } from "../types";
import { buildOrderTextTemplate } from "./order-text";

const MESSAGE_LIMIT = 4900;
const ORDER_MESSAGE_LIMIT = 4; // One completion message + four text objects in the same retry-key request.
const singleLine = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

/** Supplier-ready rows preserve order quantities and leave internal review flags unchanged. */
export function buildAnalysisCompletionMessages(result: ParsedMemoPayload, siteName?: string | null, now = new Date()) {
  const site = singleLine(siteName).slice(0, 200);
  const completion = { type: "text", text: `✅ ソクパ解析が完了しました！${site ? `\n現場：${site}` : ""}\nアプリを開いて結果を確認してください。` };
  const rows = result.items.map(item => {
    const rawCode = singleLine(item.product_code);
    const invalidCode = !rawCode || rawCode.length > 160;
    const quantity = typeof item.order_quantity === "number" ? item.order_quantity
      : typeof item.order_quantity === "string" && /^\d+(?:\.\d+)?$/.test(item.order_quantity) ? Number(item.order_quantity) : NaN;
    const validQuantity = Number.isFinite(quantity) && quantity > 0 && quantity <= Number.MAX_SAFE_INTEGER;
    // Never fall back to raw total_m: it does not include the order allowance.
    return { productCode: invalidCode ? "品番をアプリで確認" : rawCode,
      quantityText: validQuantity ? `${quantity}m` : "未確定（要確認）" };
  });
  const empty = buildOrderTextTemplate([], site, now);
  const header = empty.slice(0, empty.indexOf("（品番なし）")).trim();
  const prefix = `${header}\n`;
  const lines = rows.map(row => `・品番：${row.productCode} / 数量：${row.quantityText}`);
  if (!lines.length) lines.push("（品番・数量をアプリで確認してください）");
  const chunks: string[] = [];
  let current = prefix;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Leave room for an explicit overflow notice; never silently omit the entire list.
    if (current.length + line.length + 100 > MESSAGE_LIMIT) {
      if (chunks.length === ORDER_MESSAGE_LIMIT - 1) {
        current += `\n※長いため残り${lines.length - index}品番は省略しています。全件はアプリで確認してください。`;
        break;
      }
      chunks.push(current.trim()); current = prefix;
    }
    current += `${line}\n`;
  }
  chunks.push(current.trim());
  return [completion, ...chunks.map(text => ({ type: "text", text }))];
}
