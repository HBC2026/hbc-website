/** Knowledge-base retrieval: ranks approved library entries by similarity to the activity, hazard and equipment being written. */
import type { Reference, RuleRef } from './prompt.ts';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'work', 'works', 'working', 'using', 'use', 'new']);

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.replace(/(ing|ers|er|es|s)$/, '') || w);          // crude stemming: cutting/cutter/cuts -> cutt/cutt/cut
  }
  return out;
}

const overlap = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0; a.forEach((w) => { if (b.has(w)) n++; });
  return n / Math.min(a.size, b.size);
};

export interface KbCandidate extends Reference { tags?: string[] }
export interface Query { activity: string; category: string; hazard: string; equipment: string }

export function scoreEntry(e: KbCandidate, q: Query): number {
  const hz = tokens(`${q.category} ${q.hazard}`);
  const act = tokens(q.activity);
  const eq = tokens(q.equipment);
  const tags = tokens((e.tags ?? []).join(' '));
  const sameHazard = overlap(hz, tokens(e.hazard));
  const score =
    3 * overlap(act, tokens(e.work_activity)) +
    3 * sameHazard +
    2 * overlap(eq, tokens(e.equipment)) +
    1 * Math.max(overlap(act, tags), overlap(eq, tags), overlap(hz, tags));
  // an entry for a different hazard is rarely useful even if the activity matches
  return sameHazard === 0 && hz.size && tokens(e.hazard).size ? score * 0.4 : score;
}

/** Top `limit` entries with a meaningful score. */
export function rankReferences(entries: KbCandidate[], q: Query, limit = 4, min = 1.2): KbCandidate[] {
  return entries
    .map((e) => ({ e, s: e.controls.length ? scoreEntry(e, q) : 0 }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Company/client rules always apply; equipment rules only when the equipment or activity mentions their equipment. */
export function selectRules<T extends RuleRef & { active?: boolean }>(rules: T[], text: string, budget = 7000): T[] {
  const t = tokens(text);
  const out: T[] = []; let used = 0;
  for (const r of rules) {
    if (r.active === false) continue;
    if (r.kind === 'equipment' && overlap(tokens(r.equipment ?? r.title), t) < 0.5) continue;
    const len = r.title.length + r.body.length;
    if (used + len > budget) continue;
    used += len; out.push(r);
  }
  return out;
}
