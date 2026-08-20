export type OrderTextTemplateItem = {
  productCode: unknown;
  quantityText: string;
};

export function buildOrderTextTemplate(
  items: readonly OrderTextTemplateItem[],
  siteName: string | null | undefined,
  now = new Date(),
): string {
  const dateStr = now.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let text = "";
  text += `現場名：${siteName?.trim() || "未入力"}\n`;
  text += `日時：${dateStr}\n\n`;
  text += `【発注リスト】\n`;

  if (items.length === 0) {
    text += "（品番なし）\n";
  } else {
    for (const item of items) {
      const code = String(item.productCode ?? "").trim() || "不明";
      const quantityText = item.quantityText.trim() || "数量不明";
      text += `・品番：${code} / 数量：${quantityText}\n`;
    }
  }

  return text.trim();
}

export function buildOrderRequestText(items: any[], siteName: string | null | undefined): string {
  const templateItems = items.map((item) => {
    const orderQty = Number(item?.order_quantity);
    const totalM = Number(item?.total_m);
    const quantityText =
      Number.isFinite(orderQty) && orderQty > 0
        ? `${orderQty}m`
        : Number.isFinite(totalM) && totalM > 0
          ? `${totalM}m`
          : "数量不明";

    return {
      productCode: item?.product_code,
      quantityText,
    };
  });

  return buildOrderTextTemplate(templateItems, siteName);
}
