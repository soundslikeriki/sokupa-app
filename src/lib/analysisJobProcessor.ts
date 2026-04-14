import type { SupabaseClient } from "@supabase/supabase-js";

type ParsedMemoPayload = {
  items: any[];
  notes?: string;
  needs_review_any?: boolean;
};

function mergeParsedPayloads(payloads: ParsedMemoPayload[]): ParsedMemoPayload {
  const map = new Map<string, any>();
  const notesBits: string[] = [];
  for (const p of payloads) {
    if (p?.notes && typeof p.notes === "string" && p.notes.trim()) notesBits.push(p.notes.trim());
    const items = Array.isArray(p?.items) ? p.items : [];
    for (const it of items) {
      const code = String(it?.product_code ?? "").trim();
      if (!code) continue;
      const existing = map.get(code);
      if (!existing) {
        map.set(code, it);
        continue;
      }
      const mergedEntries = [...(existing.entries ?? []), ...(it.entries ?? [])];
      const totalFromEntries = mergedEntries.reduce((s: number, e: any) => s + (Number(e?.subtotal_m) || 0), 0);
      map.set(code, {
        ...existing,
        ...it,
        entries: mergedEntries,
        total_m: Number.isFinite(Number(it.total_m)) && Number(it.total_m) > 0 ? Number(it.total_m) : totalFromEntries,
      });
    }
  }
  const items = Array.from(map.values());
  return {
    items,
    notes: notesBits.length ? Array.from(new Set(notesBits)).join("\n") : "",
    needs_review_any: items.some((i: any) => Boolean(i?.needs_review)),
  };
}

function getBaseUrlFromHeaders(headers: Headers): string {
  const host = headers.get("host") || "localhost:3000";
  const proto = headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

function buildOrderText(result: ParsedMemoPayload, siteName: string | null): string {
  const site = siteName?.trim() || "";
  const lines: string[] = [];
  lines.push("作成型：計測メモ解析アプリ（ソクパ）");
  lines.push(`現場名：${site || "未入力"}`);
  lines.push(
    `日時：${new Date().toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })}`,
  );
  lines.push("");
  lines.push("【発注リスト】");

  const items = Array.isArray(result?.items) ? result.items : [];
  if (items.length === 0) {
    lines.push("（品番なし）");
  } else {
    for (const item of items) {
      const code = String(item?.product_code ?? "").trim() || "不明";
      const orderQty = Number(item?.order_quantity);
      const totalM = Number(item?.total_m);
      const qtyStr =
        Number.isFinite(orderQty) && orderQty > 0
          ? `${orderQty}m`
          : Number.isFinite(totalM) && totalM > 0
            ? `${totalM}m`
            : "数量不明";
      lines.push(`・品番：${code} / 数量：${qtyStr}`);
    }
  }

  if (result?.notes?.trim()) {
    lines.push("");
    lines.push(`【備考】\n${result.notes.trim()}`);
  }

  return lines.join("\n");
}

async function sendLineCompletion(siteName: string | null, result?: ParsedMemoPayload) {
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const lineUserId = process.env.LINE_USER_ID;
  if (!lineToken || !lineUserId) {
    console.error("[sendLine] LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID is not set");
    return;
  }

  const site = siteName?.trim() || "";

  // 1通目：完了通知
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [
        {
          type: "text",
          text: `✅ ソクパ解析が完了しました！${site ? `\n現場：${site}` : ""}\nアプリを開いて結果を確認してください。`,
        },
      ],
    }),
  }).catch((e) => console.error("[sendLine] 1通目失敗:", e));

  await new Promise((r) => setTimeout(r, 500));

  // 2通目：発注テキスト
  if (result && Array.isArray(result.items) && result.items.length > 0) {
    const text = buildOrderText(result, siteName);
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineToken}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: "text", text }],
      }),
    }).catch((e) => console.error("[sendLine] 2通目失敗:", e));
  }
}

/**
 * 1ステップだけ解析を進める（1枚 or finalize）。
 * Vercel の実行時間制限があるため、呼び出し側でループして複数回叩く想定。
 */
export async function processAnalysisJobStep(opts: {
  admin: SupabaseClient;
  jobId: string;
  headers: Headers;
}): Promise<{ status: "running" | "done" | "failed"; error?: string }> {
  const { admin, jobId, headers } = opts;
  const baseUrl = getBaseUrlFromHeaders(headers);

  const { data: job, error: jobErr } = await admin
    .from("analysis_jobs")
    .select("id,status,site_name,context,total_images,done_images")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) {
    console.error("[analysis-job] job fetch failed", { jobId, jobErr });
    return { status: "failed", error: jobErr?.message || "job not found" };
  }
  if (job.status === "done" || job.status === "failed") {
    return { status: job.status as any };
  }

  const { data: img, error: imgErr } = await admin
    .from("analysis_job_images")
    .select("id,idx,url,status")
    .eq("job_id", jobId)
    .in("status", ["queued", "running"])
    .order("idx", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (imgErr) {
    console.error("[analysis-job] image pick failed", { jobId, imgErr });
    return { status: "failed", error: imgErr.message };
  }

  if (!img) {
    console.log("[analysis-job] finalize", { jobId });
    const { data: rows, error: rowsErr } = await admin
      .from("analysis_job_images")
      .select("idx,parsed,status")
      .eq("job_id", jobId)
      .order("idx", { ascending: true });
    if (rowsErr) {
      console.error("[analysis-job] finalize rows failed", { jobId, rowsErr });
      return { status: "failed", error: rowsErr.message };
    }

    const payloads = (rows ?? [])
      .filter((r: any) => r.status === "done" && r.parsed)
      .map((r: any) => r.parsed as ParsedMemoPayload);
    const resultPayload = mergeParsedPayloads(payloads);

    const { error: finErr } = await admin
      .from("analysis_jobs")
      .update({
        status: "done",
        done_images: job.total_images ?? 0,
        result: resultPayload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (finErr) {
      console.error("[analysis-job] finalize job update failed", { jobId, finErr });
      return { status: "failed", error: finErr.message };
    }

    await sendLineCompletion(typeof job.site_name === "string" ? job.site_name : null, resultPayload);
    return { status: "done" };
  }

  console.log("[analysis-job] start image", { jobId, imageId: img.id, idx: img.idx });
  await admin.from("analysis_jobs").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", jobId);
  await admin
    .from("analysis_job_images")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", img.id);

  try {
    const context = job.context && typeof job.context === "object" ? job.context : {};
    const parseRes = await fetch(`${baseUrl}/api/parse-memo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: img.url,
        mimeType: "image/jpeg",
        context,
      }),
    });
    const parseJson = (await parseRes.json()) as any;
    if (!parseRes.ok || parseJson?.error) {
      throw new Error(parseJson?.error || `parse-memo failed: ${parseRes.status}`);
    }

    const { error: upImgErr } = await admin
      .from("analysis_job_images")
      .update({
        status: "done",
        parsed: parseJson?.data ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", img.id);
    if (upImgErr) {
      throw new Error(upImgErr.message);
    }

    const { count } = await admin
      .from("analysis_job_images")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "done");

    const { error: upJobErr } = await admin
      .from("analysis_jobs")
      .update({
        done_images: typeof count === "number" ? count : job.done_images ?? 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (upJobErr) {
      console.error("[analysis-job] job progress update failed", { jobId, upJobErr });
    }

    return { status: "running" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[analysis-job] image failed", { jobId, imageId: img.id, msg });
    await admin
      .from("analysis_job_images")
      .update({ status: "failed", error: msg, updated_at: new Date().toISOString() })
      .eq("id", img.id);
    await admin.from("analysis_jobs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", jobId);
    return { status: "failed", error: msg };
  }
}
