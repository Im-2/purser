/** Edit distance, homoglyph skeletons and the deterministic makeLookalike helper. Pure, no I/O. */

/** Optimal-string-alignment (Damerau-Levenshtein with adjacent transpositions). */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d: number[][] = Array.from({ length: al + 1 }, (_, i) => [i, ...Array<number>(bl).fill(0)]);
  for (let j = 0; j <= bl; j++) d[0]![j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[al]![bl]!;
}

// Non-Latin look-alikes (Cyrillic and Greek) that render like Latin letters.
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "һ": "h",
  "ο": "o", "α": "a", "ε": "e", "ρ": "p", "ν": "v", "ι": "i", "κ": "k",
};
// Single-character digit/symbol swaps. Mapped to the letter they imitate; 1 and l and I all collapse to "l".
const CHAR_MAP: Record<string, string> = { "0": "o", "1": "l", "!": "l", "|": "l", "5": "s", "$": "s", "@": "a", "3": "e", "i": "l" };

/**
 * Collapse visually confusable spellings to one skeleton: acme -> "acme", acrne/aeme variants: rn->m, vv->w, cl->d,
 * 0->o, 1/l/i->l, plus Unicode homoglyphs. Two different strings with the same skeleton are look-alikes.
 */
export function skeleton(s: string): string {
  let out = s.normalize("NFKD").toLowerCase();
  out = [...out].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  out = out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
  out = [...out].map((ch) => CHAR_MAP[ch] ?? ch).join("");
  out = out.replace(/(.)\1+/g, "$1"); // doubled letters collapse
  return out;
}

export function splitEmail(email: string): { local: string; domain: string } | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

export type LookalikeKind = "zero" | "one" | "rn" | "double";

/**
 * Deterministically produce a one-character-swapped copy of an email's local part (same domain), for scenarios and tests.
 * The result is never a real account. Priority: o->0, l->1, m->rn, otherwise double a letter. Pass `kind` to force one.
 */
export function makeLookalike(email: string, kind?: LookalikeKind): string {
  const parts = splitEmail(email);
  if (!parts) throw new Error("makeLookalike: not an email address");
  const { local, domain } = parts;
  const swap = (k: LookalikeKind): string | null => {
    switch (k) {
      case "zero": {
        const i = local.indexOf("o");
        return i < 0 ? null : local.slice(0, i) + "0" + local.slice(i + 1);
      }
      case "one": {
        const i = local.indexOf("l");
        return i < 0 ? null : local.slice(0, i) + "1" + local.slice(i + 1);
      }
      case "rn": {
        const i = local.indexOf("m");
        return i < 0 ? null : local.slice(0, i) + "rn" + local.slice(i + 1);
      }
      case "double": {
        const i = [...local].findIndex((c) => /[a-z]/.test(c));
        return i < 0 ? null : local.slice(0, i + 1) + local[i] + local.slice(i + 1);
      }
    }
  };
  const order: LookalikeKind[] = kind ? [kind] : ["zero", "one", "rn", "double"];
  for (const k of order) {
    const out = swap(k);
    if (out && out !== local) return `${out}@${domain}`;
  }
  // Last resort: append a doubled final character so the result always differs.
  return `${local}${local.slice(-1)}@${domain}`;
}
