import type { MemoEntry } from "../types";

/** An array position is not identity after a deletion. Never guess an ambiguous legacy row. */
export function findOriginalMemoEntry(originals: MemoEntry[], current: MemoEntry | undefined): MemoEntry | undefined {
  if (!current) return undefined;
  const matches = current.source_row_id
    ? originals.filter(entry => entry.source_row_id === current.source_row_id)
    : originals.filter(entry => !entry.source_row_id && entry.original_formula === current.original_formula &&
      entry.source_image_index === current.source_image_index && entry.source_entry_index === current.source_entry_index);
  return matches.length === 1 ? matches[0] : undefined;
}
