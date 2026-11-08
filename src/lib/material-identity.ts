import type { MemoProductItem } from "../types";

export const validMaterialId = (value: unknown): value is string => typeof value === "string" && /^material-v1-[a-z0-9-]{1,100}$/.test(value);

/** Immutable source references, never product codes, quantities or array positions. */
export function materialSources(item: MemoProductItem): string[] {
  return [...new Set(item.entries.flatMap(entry => entry.source_row_id
    ? [JSON.stringify(["row", entry.source_row_id])]
    : Number.isSafeInteger(entry.source_image_index) && Number.isSafeInteger(entry.source_entry_index)
      ? [JSON.stringify(["image-row", entry.source_image_index, entry.source_entry_index])] : []))].sort();
}

export function materialSignature(item: MemoProductItem): string {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "client_material_id").sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : value;
  return JSON.stringify(normalize(item));
}

// A deterministic birth identifier avoids competing IDs on two initial tabs.
// It is not an authentication key. Live replacements only reuse proven IDs.
function birthSeed(value: string): string {
  const hashes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let index = 0; index < value.length; index++) for (let lane = 0; lane < hashes.length; lane++) hashes[lane] = Math.imul(hashes[lane] ^ value.charCodeAt(index), 16777619 + lane * 2) >>> 0;
  return hashes.map(hash => hash.toString(16).padStart(8, "0")).join("");
}

export function identifyMaterials(previous: MemoProductItem[], incoming: MemoProductItem[], context: string,
  fresh = () => `material-v1-${crypto.randomUUID()}`): MemoProductItem[] {
  const previousById = new Map(previous.filter(item => validMaterialId(item.client_material_id)).map(item => [item.client_material_id!, item]));
  const ids = new Map<string, number>(), incomingOwners = new Map<string, number[]>(), previousOwners = new Map<string, string[]>();
  incoming.forEach((item, index) => {
    if (validMaterialId(item.client_material_id)) ids.set(item.client_material_id, (ids.get(item.client_material_id) ?? 0) + 1);
    for (const source of materialSources(item)) incomingOwners.set(source, [...(incomingOwners.get(source) ?? []), index]);
  });
  for (const [id, item] of previousById) for (const source of materialSources(item)) previousOwners.set(source, [...(previousOwners.get(source) ?? []), id]);
  const proposed = incoming.map(item => {
    if (validMaterialId(item.client_material_id)) {
      if (ids.get(item.client_material_id) !== 1) return null;
      const old = previousById.get(item.client_material_id), before = old ? materialSources(old) : [], after = materialSources(item);
      return before.length && after.length && !before.some(source => after.includes(source)) ? null : { id: item.client_material_id, explicit: true };
    }
    const matches = new Set(materialSources(item).flatMap(source => incomingOwners.get(source)?.length === 1 && previousOwners.get(source)?.length === 1 ? previousOwners.get(source)! : []));
    return matches.size === 1 ? { id: [...matches][0], explicit: false } : null;
  });
  const claims = new Map<string, number>();
  for (const proposal of proposed) if (proposal) claims.set(proposal.id, (claims.get(proposal.id) ?? 0) + 1);
  const used = new Set<string>(), seed = birthSeed(JSON.stringify([context, incoming.map(materialSignature)]));
  return incoming.map((item, index) => {
    const proposal = proposed[index];
    let id = proposal && (proposal.explicit || claims.get(proposal.id) === 1) && !used.has(proposal.id) ? proposal.id : null;
    if (!id && previous.length === 0 && !validMaterialId(item.client_material_id)) id = `material-v1-${seed}-${index}`;
    if (!id || used.has(id)) {
      let attempts = 0;
      do { id = fresh(); if (++attempts > 100) throw new Error("材料の識別情報を用意できません。元の入力は保持しています。"); }
      while (!validMaterialId(id) || used.has(id) || previousById.has(id));
    }
    used.add(id);
    return { ...item, client_material_id: id };
  });
}

export function originalMaterial(item: MemoProductItem, originals: MemoProductItem[], allowUniqueCode = false): MemoProductItem | undefined {
  const explicit = originals.filter(original => validMaterialId(item.client_material_id) && original.client_material_id === item.client_material_id);
  if (explicit.length === 1) return explicit[0];
  const sources = materialSources(item), matching = originals.filter(original => materialSources(original).some(source => sources.includes(source)));
  if (matching.length === 1) return matching[0];
  const exact = originals.filter(original => materialSignature(original) === materialSignature(item));
  if (exact.length) return exact[0]; // Every matching original contains identical source values.
  const byCode = allowUniqueCode && sources.length === 0 ? originals.filter(original => materialSources(original).length === 0 && original.product_code === item.product_code) : [];
  return byCode.length === 1 ? byCode[0] : undefined;
}
