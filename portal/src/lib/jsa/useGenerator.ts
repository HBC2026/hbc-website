'use client';
/** Runs AI generation for chosen hazards and merges the results into the document without losing the administrator's edits. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { aiStatus, generateControls, type GenParams } from './client';
import { applyGeneration, planGeneration, replaceSelected, type GenMode } from './merge';
import { hazardName, type JActivity, type JHazard, type JsaDoc, type JsaSettings } from './types';
import type { JsaEditor } from './useJsaDoc';

export interface Job {
  hazardId: string; label: string; status: 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'cancelled';
  added: number; message?: string; flags: string[]; gaps: string[]; references: number;
}
export interface AiState { checked: boolean; configured: boolean; provider?: string | null; model?: string | null; error?: string }

const POOL = 2;

function find(doc: JsaDoc, hazardId: string): { a: JActivity; h: JHazard } | null {
  for (const a of doc.activities) { const h = a.hazards.find((x) => x.id === hazardId); if (h) return { a, h }; }
  return null;
}

export function paramsFor(doc: JsaDoc, a: JActivity, h: JHazard): GenParams {
  const hd = doc.header;
  return {
    activity: a.title, activityEquipment: a.equipment, activityInstructions: a.instructions,
    category: h.category, hazardName: hazardName(h), hazardInstructions: h.instructions,
    equipment: hd.equipment, instructions: hd.ai_instructions,
    job: { project: hd.project, client: hd.client, location: hd.location, work_description: hd.work_description, equipment: hd.equipment, additional_instructions: hd.additional_instructions },
  };
}

export function useGenerator(ed: JsaEditor, settings: JsaSettings) {
  const { toast, confirmDialog } = useApp();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [running, setRunning] = useState(false);
  const [ai, setAi] = useState<AiState>({ checked: false, configured: false });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    aiStatus().then((s) => setAi({ checked: true, ...s })).catch((e) => setAi({ checked: true, configured: false, error: e instanceof Error ? e.message : String(e) }));
  }, []);

  const patch = (id: string, p: Partial<Job>) => setJobs((j) => ({ ...j, [id]: { ...(j[id] ?? { hazardId: id, label: '', status: 'queued', added: 0, flags: [], gaps: [], references: 0 }), ...p } }));

  const run = useCallback(async (hazardIds: string[], opts: { mode: GenMode; count?: number }) => {
    const doc = ed.getDoc();
    if (!doc || ed.locked || running) return;
    if (!ai.configured) { toast(ai.error ?? 'AI generation is not configured on the server.', true); return; }
    const target = Math.min(80, Math.max(3, Math.round(opts.count ?? settings.default_control_count)));
    const items = hazardIds.map((id) => find(doc, id)).filter((x): x is { a: JActivity; h: JHazard } => !!x);
    if (!items.length) { toast('Select at least one hazard.', true); return; }
    if (items.some(({ a }) => !a.title.trim())) { toast('Give every selected activity a name first.', true); return; }

    // confirm anything that discards work
    const plans = items.map(({ h }) => planGeneration(h.controls, opts.mode, target));
    const removing = plans.reduce((n, p) => n + p.remove.length, 0);
    const protectedCount = plans.reduce((n, p) => n + p.remove.filter((c) => c.edited || c.origin !== 'ai').length, 0);
    if (removing > 0) {
      const ok = await confirmDialog({
        title: protectedCount ? 'Replace controls you edited?' : 'Replace existing controls?',
        message: protectedCount
          ? `${removing} existing control measure${removing === 1 ? '' : 's'} will be replaced, including ${protectedCount} that you wrote or edited. New controls are generated first; if generation fails, nothing is removed.`
          : `${removing} AI-generated control measure${removing === 1 ? '' : 's'} you have not edited will be replaced. Your own and edited controls are kept.`,
        confirmLabel: 'Replace', danger: protectedCount > 0,
      });
      if (!ok) return;
    }

    const ctl = new AbortController(); abort.current = ctl; setRunning(true);
    setJobs(Object.fromEntries(items.map(({ h }) => [h.id, { hazardId: h.id, label: hazardName(h), status: 'queued', added: 0, flags: [], gaps: [], references: 0 } as Job])));

    let next = 0;
    const worker = async () => {
      while (next < items.length && !ctl.signal.aborted) {
        const i = next++;
        const { a, h } = items[i]; const plan = plans[i];
        if (plan.need === 0) { patch(h.id, { status: 'skipped', message: `Already has ${h.controls.length} controls` }); continue; }
        patch(h.id, { status: 'running' });
        const cur = ed.getDoc() ?? doc;
        const live = find(cur, h.id);
        if (!live) { patch(h.id, { status: 'skipped', message: 'Hazard was removed' }); continue; }
        const p = paramsFor(cur, live.a, live.h);
        const out = await generateControls(p, plan.keep.map((c) => c.text), plan.need, ctl.signal);
        if (out.controls.length) {
          ed.update((d) => {
            const f = d.activities.flatMap((x) => x.hazards).find((x) => x.id === h.id);
            if (f) f.controls = applyGeneration(f.controls as never, plan, opts.mode, out.controls) as never;
          });
        }
        patch(h.id, {
          status: ctl.signal.aborted && !out.controls.length ? 'cancelled' : out.error && !out.controls.length ? 'error' : 'done',
          added: out.controls.length, flags: out.flags, gaps: out.gaps, references: out.references.length,
          message: out.error ? (out.controls.length ? `Partial: ${out.error}` : out.error) : undefined,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
    items.forEach(({ h }) => setJobs((j) => (j[h.id]?.status === 'queued' ? { ...j, [h.id]: { ...j[h.id], status: 'cancelled' } } : j)));
    setRunning(false); abort.current = null;
  }, [ed, ai, running, settings.default_control_count, toast, confirmDialog]);

  /** Regenerate only the selected controls of one hazard, in place. */
  const regenerateSelected = useCallback(async (hazardId: string, selected: Set<string>) => {
    const doc = ed.getDoc(); if (!doc || ed.locked || running || !selected.size) return false;
    if (!ai.configured) { toast(ai.error ?? 'AI generation is not configured on the server.', true); return false; }
    const f = find(doc, hazardId); if (!f) return false;
    const chosen = f.h.controls.filter((c) => selected.has(c.id));
    const edited = chosen.filter((c) => c.edited || c.origin !== 'ai').length;
    if (!(await confirmDialog({
      title: 'Regenerate selected controls?',
      message: `${chosen.length} selected control${chosen.length === 1 ? '' : 's'} will be replaced with new ones${edited ? `, including ${edited} that you wrote or edited` : ''}. Other controls are not touched.`,
      confirmLabel: 'Regenerate', danger: edited > 0,
    }))) return false;
    const ctl = new AbortController(); abort.current = ctl; setRunning(true);
    patch(hazardId, { label: hazardName(f.h), status: 'running' });
    const keep = f.h.controls.filter((c) => !selected.has(c.id)).map((c) => c.text);
    const out = await generateControls(paramsFor(doc, f.a, f.h), keep, chosen.length, ctl.signal);
    if (out.controls.length) ed.update((d) => {
      const h = d.activities.flatMap((x) => x.hazards).find((x) => x.id === hazardId);
      if (h) h.controls = replaceSelected(h.controls as never, selected, out.controls) as never;
    });
    patch(hazardId, { status: out.error && !out.controls.length ? 'error' : 'done', added: out.controls.length, flags: out.flags, gaps: out.gaps, references: out.references.length, message: out.error });
    if (out.error) toast(out.error, true);
    setRunning(false); abort.current = null;
    return true;
  }, [ed, ai, running, toast, confirmDialog]);

  const cancel = () => abort.current?.abort();
  return { jobs, running, ai, run, regenerateSelected, cancel, clear: () => setJobs({}) };
}
export type Generator = ReturnType<typeof useGenerator>;
