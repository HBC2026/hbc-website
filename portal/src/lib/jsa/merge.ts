/** How AI results are merged into a hazard's controls without losing the administrator's work. Pure functions. */
import { isDuplicate } from './dedupe.ts';
import { uid, type JControl } from './types.ts';

/** fill: keep everything, top up to the target. replace_ai: drop untouched AI controls. replace_all: drop everything (confirmed). add_more: keep everything, add N. */
export type GenMode = 'fill' | 'replace_ai' | 'replace_all' | 'add_more';

/** A control the administrator wrote, edited, or took from the library/template is never replaced without confirmation. */
export const isProtected = (c: Pick<JControl, 'edited' | 'origin'>) => c.edited || c.origin !== 'ai';

export interface GenPlan { keep: JControl[]; remove: JControl[]; need: number }

export function planGeneration(controls: JControl[], mode: GenMode, target: number): GenPlan {
  if (mode === 'replace_all') return { keep: [], remove: controls, need: target };
  if (mode === 'replace_ai') {
    const remove = controls.filter((c) => !isProtected(c));
    const keep = controls.filter((c) => isProtected(c));
    return { keep, remove, need: Math.max(0, target - keep.length) };
  }
  if (mode === 'add_more') return { keep: controls, remove: [], need: target };
  return { keep: controls, remove: [], need: Math.max(0, target - controls.length) };
}

/**
 * Applies new texts to the CURRENT controls (which may have changed since the plan was made).
 * Controls scheduled for removal are removed only if they still exist and — for replace_ai — are still unprotected.
 * New texts that duplicate a surviving control are skipped, so retries can never add the same control twice.
 */
export function applyGeneration(current: JControl[], plan: GenPlan, mode: GenMode, texts: string[], origin: JControl['origin'] = 'ai'): JControl[] {
  const gone = new Set(plan.remove.filter((r) => {
    const now = current.find((c) => c.id === r.id);
    return now && (mode === 'replace_all' || !isProtected(now));
  }).map((r) => r.id));
  const kept = current.filter((c) => !gone.has(c.id));
  const out = [...kept];
  for (const t of texts) {
    if (!t.trim() || isDuplicate(t, out.map((c) => c.text))) continue;
    out.push({ id: uid(), text: t.trim(), origin, edited: false });
  }
  return out;
}

/** Regenerating selected controls: each selected control is replaced in place by the next new text. */
export function replaceSelected(current: JControl[], selected: Set<string>, texts: string[]): JControl[] {
  const out: JControl[] = []; let i = 0; let lastSel = -1;
  const others = current.filter((c) => !selected.has(c.id)).map((c) => c.text);
  const fresh = texts.filter((t) => t.trim() && !isDuplicate(t, others));
  for (const c of current) {
    if (selected.has(c.id) && i < fresh.length) { out.push({ id: uid(), text: fresh[i++].trim(), origin: 'ai', edited: false }); lastSel = out.length; }
    else out.push(c);
  }
  if (i < fresh.length) {
    const extra = fresh.slice(i).map((t) => ({ id: uid(), text: t.trim(), origin: 'ai' as const, edited: false }));
    out.splice(lastSel < 0 ? out.length : lastSel, 0, ...extra);
  }
  return out;
}
