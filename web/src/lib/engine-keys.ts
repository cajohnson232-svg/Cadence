// The engine tells institutions apart by a short text key and shift categories by name. Neither is unique in the
// database (two institutions may share a short code, two categories a name), and a shared key would make the engine
// treat two institutions as one: a person assigned to one could be put on the other's shifts, and imported shifts
// filed under the wrong one. So every program-level key sent to the engine goes through here, in both directions.

/** id -> key, unique within the list: the plain key when nobody else has it, otherwise made unique. */
export function uniqueKeys<T extends { id: string }>(xs: T[], base: (x: T) => string, detail: (x: T) => string): Map<string, string> {
  const sorted = [...xs].sort((a, b) => a.id.localeCompare(b.id));
  const count = new Map<string, number>();
  for (const x of sorted) count.set(base(x), (count.get(base(x)) ?? 0) + 1);
  const out = new Map<string, string>(), used = new Set<string>();
  for (const x of sorted) {
    let k = base(x);
    if (count.get(k)! > 1 || !k) k = `${k || "?"} (${detail(x)})`;
    for (let n = 2; used.has(k); n++) k = `${base(x) || "?"} (${detail(x)} ${n})`;
    used.add(k); out.set(x.id, k);
  }
  return out;
}

export const siteKeys = (insts: { id: string; shortCode: string; name: string }[]) => uniqueKeys(insts, (i) => i.shortCode.trim() || i.name.trim(), (i) => i.name.trim() || i.id);
export const categoryKeys = (cats: { id: string; name: string }[]) => uniqueKeys(cats, (c) => c.name.trim(), (c) => `#${c.id.slice(-4)}`);

/** key -> id, for reading the engine's result back. */
export const invert = (m: Map<string, string>) => new Map([...m].map(([id, k]) => [k, id]));
