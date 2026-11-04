import type { MemoReadingReview } from "../types";

const READING_CHANGE = /訂正|修正|書き?直|書き?換|取消|取り?消|打ち?消|抹消|除外|cross(?:ed)?\s*out|strike[- ]?(?:through|out)|correct(?:ed|ion)|cancel(?:led|ed|lation)?|omit(?:ted)?|exclud(?:ed|ing)/iu;
const MAX_REVIEWS = 64;
const MAX_CANDIDATES = 32;
const text = (value: unknown, max = 4000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const distinct = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

/** Keep a possible omitted/corrected row as evidence, never as an automatic quantity. */
export function candidateFormulasInNotes(note: string): string[] {
  return distinct(Array.from(note.matchAll(/\d+(?:[.,-]\d+)?\s*(?:m|ｍ)?\s*[×xX＊*]\s*(?:\([\d\s.+＋\-−]{1,100}\)|\d+(?:\.\d+)?(?:\s*[+＋\-−]\s*\d+(?:\.\d+)?)*)/gu), match => match[0].trim())).slice(0, MAX_CANDIDATES);
}

export function normalizeReadingReviews(value: unknown): MemoReadingReview[] {
  if (!Array.isArray(value)) return [];
  const reviews: MemoReadingReview[] = [];
  for (const raw of value.slice(0, MAX_REVIEWS)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const reason = text(row.reason);
    if (!reason) continue;
    const candidate_formulas = distinct(Array.isArray(row.candidate_formulas) ? row.candidate_formulas.map(candidate => text(candidate, 400)) : []).slice(0, MAX_CANDIDATES);
    const source = row.source_image_index;
    reviews.push({ reason, candidate_formulas,
      ...(typeof source === "number" && Number.isSafeInteger(source) && source >= 0 && source < 16 ? { source_image_index: source } : {}) });
  }
  const unique = new Map(reviews.map(review => [JSON.stringify(review), review]));
  return Array.from(unique.values());
}

function reviewFromNotes(value: unknown): MemoReadingReview[] {
  const reason = text(value);
  return reason && READING_CHANGE.test(reason) ? [{ reason, candidate_formulas: candidateFormulasInNotes(reason) }] : [];
}

function explicitVisionReview(item: Record<string, unknown>): MemoReadingReview[] {
  const existing = normalizeReadingReviews(item.reading_reviews);
  const local = reviewFromNotes(item.notes);
  const rawCandidates = Array.isArray(item.correction_candidates) ? item.correction_candidates : [];
  const candidates = distinct(rawCandidates.slice(0, MAX_CANDIDATES).map(raw => {
    if (typeof raw === "string") return text(raw, 400);
    if (!raw || typeof raw !== "object") return "";
    const row = raw as Record<string, unknown>;
    return text(row.original_formula ?? row.formula, 400);
  }));
  if (candidates.length || item.correction_needs_review === true) {
    const candidateReasons = distinct(rawCandidates.flatMap(raw => raw && typeof raw === "object" ? [text((raw as Record<string, unknown>).reason)] : []));
    const reason = text(item.correction_reason) || text([text(item.notes), ...candidateReasons].filter(Boolean).join(" / ")) || "訂正・取消の候補を原画像と照合し、有効な行を確認してください。";
    local.push({ reason, candidate_formulas: distinct([...candidates, ...candidateFormulasInNotes(reason)]) });
  }
  return normalizeReadingReviews([...existing, ...local]);
}

/** Capture Vision evidence before catalog enrichment can replace notes or review flags. */
export function annotateVisionReadingReviews(items: Record<string, unknown>[], globalNotes?: unknown): Record<string, unknown>[] {
  const local = items.map(explicitVisionReview);
  // Global evidence can describe a different omitted row, even when a local note exists.
  // Never infer its scope from the presence of other product notes.
  const global = reviewFromNotes(globalNotes);
  return items.map((item, index) => ({ ...item, vision_reading_reviews: normalizeReadingReviews([...local[index], ...global]) }));
}

/** Older saved results may only have a note; they need the same explicit review gate. */
export function readingReviewsForItem(item: { notes?: unknown; reading_reviews?: unknown }, globalNotes?: unknown): MemoReadingReview[] {
  const explicit = normalizeReadingReviews(item.reading_reviews);
  return normalizeReadingReviews([...(explicit.length ? explicit : reviewFromNotes(item.notes)), ...reviewFromNotes(globalNotes)]);
}
