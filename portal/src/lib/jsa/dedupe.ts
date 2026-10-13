/** Text normalisation and near-duplicate detection for control measures. */

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'all', 'by', 'at', 'as', 'that', 'this', 'before', 'during', 'after']);
const words = (s: string) => normalize(s).split(' ').filter((w) => w && !STOP.has(w));

/** Jaccard similarity of the significant words of two strings (0..1). */
export function similarity(a: string, b: string): number {
  const A = new Set(words(a)); const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

/** True when `text` repeats something already in `list` (exact after normalisation, or very similar). */
export function isDuplicate(text: string, list: string[], threshold = 0.85): boolean {
  const n = normalize(text);
  return list.some((x) => normalize(x) === n || similarity(x, text) >= threshold);
}

/** Removes duplicates inside one list, keeping the first occurrence. */
export function uniqueTexts(list: string[], threshold = 0.85): string[] {
  const out: string[] = [];
  for (const t of list) if (t.trim() && !isDuplicate(t, out, threshold)) out.push(t.trim());
  return out;
}
