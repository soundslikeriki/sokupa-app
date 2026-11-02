import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { calculateFinalQuantity, parseRepeatInfoRaw } from "@/lib/calc-logic";
import { validateMemoEntry, parseVisionJson, roundMeters } from "@/lib/memo-calculation";
import { createSupabaseAdmin } from "@/lib/supabaseAdmin";
import { dedupeSlashDelimited } from "@/lib/dedupeSlashList";
import { manufacturerFromOfficialUrl } from "@/lib/officialDomainManufacturer";
import { augmentProductWithCatalogSearch, type CatalogAugment } from "@/lib/wallpaperCatalogSearch";
import type { MemoProductItem } from "@/types";
import { MemoProviderError, providerError } from "@/lib/analysis-failure";

const MAX_IMAGES = 16;
/** 画像解析（JSON 安定のため Google 検索ツールは付けない） */
const VISION_MODEL = "gemini-3-flash-preview";

const SYSTEM_PROMPT = `あなたは内装職人の優秀な事務員です。
計測メモ画像（手書き含む）から壁紙の品番と計算式を正確に抽出し、以下のJSON形式のみで出力してください。他の文字は一切出力しないこと。

{
  "items": [
    {
      "product_code": "品番（例: VS2067）または項目名（例: 収納）",
      "entries": [
        {
          "original_formula": "3.20 x 6",
          "length_m": 3.20,
          "quantity": 6,
          "subtotal_m": 19.2
        }
      ],
      "total_m": 19.2
    }
  ],
  "notes": "全体の補足があればここに"
}

- 同じ品番は1つにまとめる
- メモに品番（例: TWS8266、VS2067 などの英数字コード）がない場合でも、数式（例: 2.70×60、2.70×3）があれば必ず解析対象にする
- 品番の代わりに項目名（例: 収納、アクセント、天井、腰壁、壁、玄関、LDK、洋室）が書かれている場合は、その項目名を product_code に記載する
- 項目名も品番もない数式だけの行は product_code を「未指定」にして数量を計算する
- 例: 「収納 2.70×3」 は product_code: "収納", total_m: 8.1
- 例: 「アクセント 2.70×5」 は product_code: "アクセント", total_m: 13.5
- 例: 「2.70×3」 は product_code: "未指定", total_m: 8.1
- 計算式は正確に数値化
- 掛け算と足し算が混在する式を省略して解釈しないこと。特に「2.70×60+5+5+84」のように、長さ×数量のあとに足し算が続く場合は、足し算部分も同じ長さに掛ける数量として扱う。例: 2.70×60+5+5+84 は 2.70×(60+5+5+84) = 2.70×154 = 415.8m。
- 「A×B+C+D」「A x B + C + D」「A*B+C」の形は、CやDが別の長さ表記ではなく数量の追記に見える場合、必ず A×(B+C+D) として quantity に合算値、subtotal_m に合計メートルを出すこと。
- 足し算、括弧、複数行の続きがある場合は、見えている全ての加算値を拾い、途中で切り捨てないこと。
- 幅数の減算も先に処理する。2.5×7+4-3 は 2.5×(7+4-3) = 20m。
- ハイフンは小数表記と減算の両方の可能性がある。原文の式を必ず original_formula にそのまま残し、曖昧なら needs_review: true、notes に理由を書く。推測で書き換えない。
- 画像全体が不鮮明なら image_needs_review: true、品番が不確かなら product_code_needs_review: true、個々の式が不確かなら entries の needs_review: true を付ける。notes に理由を書き、品番ブロックの confidence を0〜1で示す。`;

type ParseMemoContext = {
  site_name?: string;
  /** 直前までに判明した主要メーカー（表記統一のヒント） */
  major_manufacturers?: string[];
  /** 直前までに判明した品番（表記統一のヒント） */
  known_product_codes?: string[];
};

function buildContextHint(ctx: ParseMemoContext | undefined): string {
  if (!ctx) return "";
  const site = typeof ctx.site_name === "string" ? ctx.site_name.trim() : "";
  const mfgs = Array.isArray(ctx.major_manufacturers)
    ? ctx.major_manufacturers.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const codes = Array.isArray(ctx.known_product_codes)
    ? ctx.known_product_codes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!site && mfgs.length === 0 && codes.length === 0) return "";

  return `\n\n【現場コンテキスト（直前画像の解析結果からのヒント）】\n- 現場名: ${site || "（未指定）"}\n- 主要メーカー候補: ${mfgs.length ? mfgs.join(" / ") : "（不明）"}\n- 既知の品番候補: ${codes.length ? codes.join(" / ") : "（不明）"}\n\n【一貫性ルール】\n- 同じ品番は表記ゆれ（スペース/ハイフン/大文字小文字）を統一して同一として扱う。\n- 直前までに出たメーカー・品番が今回の画像でも見える場合は、その表記に寄せる。\n- ただし、画像から読み取れる事実を優先し、推測で捏造しない。`;
}

function normalizeImageBase64(imageBase64: string): { data: string; error?: string } {
  let raw = imageBase64.trim();
  const dataUrlMatch = /^data:([^;]+);base64,([\s\S]*)$/i.exec(raw);
  if (dataUrlMatch) {
    try {
      raw = decodeURIComponent(dataUrlMatch[2].replace(/\r?\n/g, "").replace(/\s/g, ""));
    } catch {
      raw = dataUrlMatch[2].replace(/\r?\n/g, "").replace(/\s/g, "");
    }
  } else {
    raw = raw.replace(/\r?\n/g, "").replace(/\s/g, "");
  }

  raw = raw.replace(/-/g, "+").replace(/_/g, "/");
  if (!raw) {
    return { data: "", error: "画像のBase64データが空です。" };
  }

  const invalid = raw.replace(/[A-Za-z0-9+/=]/g, "");
  if (invalid.length > 0) {
    return { data: "", error: "Base64 に不正な文字が含まれています。" };
  }

  while (raw.length % 4 !== 0) {
    raw += "=";
  }

  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 0) {
      return { data: "", error: "デコード結果が空です。画像データが欠落している可能性があります。" };
    }
  } catch {
    return { data: "", error: "Base64 のデコードに失敗しました。" };
  }

  return { data: raw };
}

function mergeVisionWithCatalog(item: Record<string, unknown>, cat: CatalogAugment): Record<string, unknown> {
  const visionNotes = typeof item.notes === "string" ? item.notes.trim() : "";
  const extra = cat.catalog_notes_extra?.trim() ?? "";
  const notesJoined = dedupeSlashDelimited([visionNotes, extra].filter(Boolean).join(" / "));

  const catMfg = cat.manufacturer?.trim() || "";
  const visionMfg = typeof item.manufacturer === "string" ? item.manufacturer.trim() : "";
  const sourceForDns =
    (typeof cat.source_url === "string" && cat.source_url.trim()) ||
    (typeof item.source_url === "string" && item.source_url.trim()) ||
    "";
  const dnsMfg = manufacturerFromOfficialUrl(sourceForDns) || "";
  const manufacturer = (dnsMfg || catMfg || visionMfg).trim();

  const specRaw =
    (cat.spec?.trim() || "") ||
    (typeof item.spec === "string" ? String(item.spec).trim() : "") ||
    "";
  const spec = specRaw ? dedupeSlashDelimited(specRaw) : "";

  const catRi = parseRepeatInfoRaw(cat.repeat_info);
  const rawRi = parseRepeatInfoRaw(item.repeat_info);
  const repeat_info =
    catRi?.from_product?.trim() ? catRi : rawRi?.from_product?.trim() ? rawRi : { from_product: "不明" };

  return {
    ...item,
    ...(manufacturer ? { manufacturer } : {}),
    ...(spec.trim() ? { spec: spec.trim() } : {}),
    repeat_info,
    ...(notesJoined ? { notes: notesJoined } : {}),
    confidence: cat.confidence,
    needs_review: cat.needs_review,
    catalog_needs_review: cat.needs_review,
    is_live_searched: cat.is_live_searched,
    ...(cat.source_url ? { source_url: cat.source_url } : {}),
    ...(cat.catalog_name ? { catalog_name: cat.catalog_name } : {}),
    ...(cat.catalog_page_num ? { catalog_page_num: cat.catalog_page_num } : {}),
  };
}

function isLikelyWallpaperProductCode(value: string): boolean {
  return /^[A-Z]{2,4}\s*[\-]?\s*\d{3,5}$/i.test(value.trim());
}

async function enrichWithProductMaster(items: any[]) {
  return await Promise.all(
    items.map(async (item) => {
      const rawCode = String(item.product_code || "").trim().toUpperCase();
      const productCode = rawCode.replace(/[\s\-]+/g, "");

      if (!productCode || !isLikelyWallpaperProductCode(productCode)) {
        return item;
      }

      let orQuery = `code.ilike.${productCode}`;
      const match = productCode.match(/^([A-Z]+)(\d+)$/i);
      if (match) {
        orQuery = `code.ilike.${productCode},code.ilike.${match[1]} ${match[2]},code.ilike.${match[1]}-${match[2]}`;
      }

      // 新しいテーブル構造に合わせたクエリ
      const { data: master } = await createSupabaseAdmin()!
        .from('wallpapers')
        .select(`
          code,
          manufacturers(name),
          catalogs(name),
          catalog_page_num,
          spec,
          repeat_v,
          repeat_h,
          pattern_match,
          notes,
          is_live_searched,
          source_url
        `)
        .or(orQuery)
        .limit(1)
        .maybeSingle();

      if (master) {
        const mfgRaw = master.manufacturers as any;
        const mfgName = mfgRaw ? (Array.isArray(mfgRaw) ? mfgRaw[0]?.name : mfgRaw.name) : undefined;
        const masterUrl = typeof master.source_url === "string" ? master.source_url.trim() : "";
        const itemUrl = typeof item.source_url === "string" ? item.source_url.trim() : "";
        const dnsMfg = manufacturerFromOfficialUrl(itemUrl || masterUrl) || "";
        const visionMfg =
          typeof item.manufacturer === "string" && item.manufacturer.trim()
            ? item.manufacturer.trim()
            : "";
        const resolvedMfg = (dnsMfg || mfgName || visionMfg || "不明").trim();
        const masterSpec = String(master.spec ?? "").trim();
        const masterIsGarbage =
          !masterSpec || masterSpec === "規格情報なし" || masterSpec === "情報なし";

        const itemSpec = String(item.spec ?? "").trim();
        const itemHasRealSpec =
          Boolean(itemSpec) && itemSpec !== "規格情報なし" && itemSpec !== "情報なし";
        const preferLiveCatalog =
          Boolean(item.is_live_searched) && (itemHasRealSpec || masterIsGarbage);

        const catRaw = master.catalogs as any;
        const catalogName = catRaw ? (Array.isArray(catRaw) ? catRaw[0]?.name : catRaw.name) : undefined;

        if (preferLiveCatalog) {
          const itemRi = parseRepeatInfoRaw(item.repeat_info);
          const fromItem = itemRi?.from_product?.trim();
          const repeat_info =
            fromItem && fromItem !== "不明"
              ? itemRi!
              : master.repeat_v && master.repeat_h
                ? { from_product: `タテ${master.repeat_v} / ヨコ${master.repeat_h}` }
                : { from_product: master.pattern_match || "不明" };

          const visionNotes = typeof item.notes === "string" ? item.notes.trim() : "";
          const masterNotes = master.notes ? String(master.notes).trim() : "";
          const notesMerged = dedupeSlashDelimited([visionNotes, masterNotes].filter(Boolean).join(" / "));

          return {
            ...item,
            product_code: master.code,
            manufacturer: resolvedMfg,
            spec: itemHasRealSpec ? itemSpec : masterSpec || "規格情報なし",
            repeat_info,
            notes: notesMerged || "",
            needs_review: false,
            source_url:
              (typeof item.source_url === "string" && item.source_url.trim()) || master.source_url,
            is_live_searched: true,
            catalog_name:
              (typeof item.catalog_name === "string" && item.catalog_name.trim()) || catalogName,
            catalog_page_num:
              (typeof item.catalog_page_num === "string" && item.catalog_page_num.trim()) ||
              (master.catalog_page_num ? String(master.catalog_page_num) : undefined),
          };
        }

        const resolvedSpec = master.spec || item.spec || "規格情報なし";

        return {
          ...item,
          product_code: master.code,
          manufacturer: resolvedMfg,
          spec: resolvedSpec,
          repeat_info: master.repeat_v && master.repeat_h
            ? { from_product: `タテ${master.repeat_v} / ヨコ${master.repeat_h}` }
            : { from_product: (master.pattern_match || "不明") },
          notes: dedupeSlashDelimited(
            master.notes
              ? `${item.notes ? String(item.notes).trim() + " / " : ""}${String(master.notes).trim()}`
              : String(item.notes || "").trim(),
          ),
          needs_review: false,
          source_url: master.source_url,
          is_live_searched: master.is_live_searched,
          catalog_name: catalogName,
          catalog_page_num: master.catalog_page_num ? String(master.catalog_page_num) : undefined,
        };
      } else {
        const resolvedMfg = item.manufacturer || "不明";
        const resolvedSpec = item.spec || "規格情報なし";
        const hasSomeInfo = resolvedMfg !== "不明" || resolvedSpec !== "規格情報なし";

        if (hasSomeInfo && !item.catalog_needs_review) {
          return {
            ...item,
            needs_review: false,
            is_live_searched: true,
          };
        } else {
          return {
            ...item,
            notes: (item.notes ? item.notes + ' ' : '') + "※この品番はデータベースに未登録です。",
            needs_review: true,
          };
        }
      }
    })
  );
}

function finalizeClientItem(raw: unknown): MemoProductItem | null {
  const r = raw as Record<string, unknown>;
  const product_code = String(r.product_code ?? "").trim() || "未指定";

  const entries = (Array.isArray(r.entries) ? r.entries : []).map(validateMemoEntry);
  if (entries.length === 0) return null;
  const totalFromEntries = entries.reduce((sum, e) => sum + e.subtotal_m, 0);
  const total_m = roundMeters(totalFromEntries);
  const order_quantity = calculateFinalQuantity(total_m);

  const sourceUrl = typeof r.source_url === "string" ? r.source_url.trim() : "";
  const dnsMfg = manufacturerFromOfficialUrl(sourceUrl) || "";
  const manufacturer = (dnsMfg || String(r.manufacturer ?? "").trim()) || "不明";
  const specRaw = String(r.spec ?? "").trim();
  const spec =
    (specRaw ? dedupeSlashDelimited(specRaw) || specRaw : "") || "規格情報なし";
  const repeat_info = parseRepeatInfoRaw(r.repeat_info) ?? { from_product: "不明" };
  const notesRaw = typeof r.notes === "string" ? r.notes.trim() : "";
  const notesJoined = notesRaw ? dedupeSlashDelimited(notesRaw) : "";
  const notes = notesJoined || undefined;

  const conf = r.confidence;
  const confidence =
    typeof conf === "number" && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : undefined;

  const is_live_searched = Boolean(r.is_live_searched);

  const review_reasons = [
    ...(Array.isArray(r.review_reasons) ? r.review_reasons.map(String) : []),
    ...entries.filter((entry) => entry.needs_review).map((entry) => `式：${entry.review_reason}`),
    ...(r.vision_needs_review || r.image_needs_review ? ["画像：不鮮明な箇所を原画像で確認してください"] : []),
    ...(r.product_code_needs_review || (typeof r.vision_confidence === "number" && r.vision_confidence < 0.8) ? ["品番：原画像の品番を確認してください"] : []),
    ...(r.catalog_needs_review || r.needs_review ? ["商品情報：カタログ情報を確認してください"] : []),
  ];
  const needs_review = review_reasons.length > 0;

  const out: MemoProductItem = {
    product_code,
    manufacturer,
    entries,
    total_m,
    order_quantity,
    spec,
    repeat_info,
    needs_review,
    review_reasons,
    is_live_searched,
  };

  // タグ抽出ロジック（よくある注意機能を抽出してtagsに入れる）
  const tags: string[] = [];
  if (notes) {
    out.notes = notes;
    const n = notes.replace(/\s/g, "");
    if (n.includes("下地注意") || n.includes("下地処理")) tags.push("下地注意");
    if (n.includes("防カビ")) tags.push("防カビ");
    if (n.includes("表面強化") || n.includes("強化")) tags.push("表面強化");
    if (n.includes("撥水")) tags.push("撥水");
    if (n.includes("抗菌")) tags.push("抗菌");
    if (n.includes("リフォーム推奨")) tags.push("リフォーム推奨");
  }
  if (tags.length > 0) out.tags = tags;

  if (confidence !== undefined) out.confidence = confidence;
  if (typeof r.source_url === "string" && r.source_url.trim()) out.source_url = r.source_url.trim();
  if (typeof r.catalog_name === "string" && r.catalog_name.trim()) out.catalog_name = r.catalog_name.trim();
  if (typeof r.catalog_page_num === "string" && r.catalog_page_num.trim()) out.catalog_page_num = r.catalog_page_num.trim();
  return out;
}

type ContentPart = string | { inlineData: { data: string; mimeType: string } };

export type ParseMemoBody = {
  base64Images?: string[]; base64Image?: string; imageBase64?: string;
  mimeType?: string; context?: ParseMemoContext;
};

export async function parseMemoBody(body: ParseMemoBody) {
  try {
    let base64Images: string[] = Array.isArray(body.base64Images)
      ? body.base64Images.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];

    if (base64Images.length === 0) {
      const single = body.base64Image ?? body.imageBase64;
      if (typeof single === "string" && single.trim().length > 0) {
        base64Images = [single];
      }
    }

    if (!base64Images || base64Images.length === 0) {
      return NextResponse.json({ error: "画像が必要です" }, { status: 400 });
    }

    if (base64Images.length > MAX_IMAGES) {
      return NextResponse.json({ error: `画像は最大${MAX_IMAGES}枚までです` }, { status: 400 });
    }

    const apiKey =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim();

    if (!apiKey) {
      throw new MemoProviderError({kind:"infrastructure",code:"configuration",retryable:false,delivery_unknown:false});
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const visionModel = genAI.getGenerativeModel({
      model: VISION_MODEL,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });

    const rawMime =
      body.mimeType === "image/jpg"
        ? "image/jpeg"
        : body.mimeType ?? "image/jpeg";
    const mimeType =
      rawMime && ["image/jpeg", "image/png", "image/webp"].includes(rawMime) ? rawMime : "image/jpeg";

    const ctxHint = buildContextHint(body.context);
    const contents: ContentPart[] = [SYSTEM_PROMPT + ctxHint];

    for (const base64 of base64Images) {
      const normalized = normalizeImageBase64(base64 || "");
      if (normalized.error) {
        return NextResponse.json({ error: normalized.error }, { status: 400 });
      }
      contents.push({
        inlineData: { data: normalized.data, mimeType },
      });
    }

    const visionStarted = Date.now();
    const signal = AbortSignal.timeout(150_000);
    let result;
    try { result = await visionModel.generateContent(contents, { signal }); }
    catch (error) { throw providerError(error, signal.aborted); }
    console.info("[parse-memo] timing", { stage: "vision", durationMs: Date.now() - visionStarted });
    const responseText = result.response.text();

    const parsedData = parseVisionJson(responseText);
    const rawItems = parsedData.items.map((item) => ({ ...item, image_needs_review: parsedData.image_needs_review === true || item.image_needs_review === true, vision_needs_review: parsedData.needs_review === true || item.needs_review, vision_confidence: item.confidence }));

    const admin = createSupabaseAdmin();
    const catalogStarted = Date.now();
    const withCatalog = await Promise.all(
      rawItems.map(async (raw) => {
        const item = raw as Record<string, unknown>;
        const code = String(item.product_code ?? "").trim();
        if (!code || !isLikelyWallpaperProductCode(code)) {
          return item;
        }
        const aug = await augmentProductWithCatalogSearch(genAI, admin, code);
        return mergeVisionWithCatalog(item, aug);
      })
    );

    console.info("[parse-memo] timing", { stage: "catalog", durationMs: Date.now() - catalogStarted, productCount: rawItems.length });
    const mergedRaw = admin
      ? await enrichWithProductMaster(withCatalog)
      : withCatalog;

    const items: MemoProductItem[] = mergedRaw
      .map((row) => finalizeClientItem(row))
      .filter((x): x is MemoProductItem => x != null);

    if (!items.length) throw new Error("計算式を読み取れませんでした。画像を確認してください。");

    const notes =
      typeof parsedData.notes === "string" && parsedData.notes.trim() ? parsedData.notes.trim() : undefined;

    const needs_review_any = items.some((i) => i.needs_review);

    return NextResponse.json({
      success: true,
      data: {
        items,
        notes: notes ?? "",
        needs_review_any,
        image_needs_review: parsedData.image_needs_review === true,
      },
      imageCount: base64Images.length,
    });
  } catch (error: unknown) {
    if (error instanceof MemoProviderError) {
      console.error("[parse-memo] provider failure", {code:error.failure.code,status:error.upstreamStatus,retryable:error.failure.retryable});
      return NextResponse.json({error:error.message,failure:error.failure},{status:error.failure.kind==="content"?422:error.upstreamStatus===429?429:503});
    }
    const message = error instanceof Error ? error.message : "画像解析に失敗しました";
    console.error("[parse-memo] content validation failed");
    return NextResponse.json({ error: message || "画像解析に失敗しました",failure:{kind:"content",code:"content",retryable:false,delivery_unknown:false} }, { status: 422 });
  }
}
