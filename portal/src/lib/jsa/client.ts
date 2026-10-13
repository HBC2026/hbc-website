'use client';
/** Browser-side access to the JSA backend: Supabase RPCs, settings, and the secured AI routes. */
import { getCompanyId, supabase, unwrap } from '@/lib/supabase';
import { isDuplicate } from './dedupe';
import { DEFAULT_JSA_SETTINGS, type JsaDoc, type JsaSettings, type JActivity } from './types';

/* ---------------------------------------------------------------- documents */
export async function loadJsa(id: string): Promise<JsaDoc | null> {
  const { data, error } = await supabase().rpc('jsa_get', { p_id: id });
  if (error) throw new Error(error.message);
  return (data as JsaDoc | null) ?? null;
}

/** Saves header + tree; returns the new version number. */
export async function saveJsa(doc: Pick<JsaDoc, 'id' | 'version' | 'header' | 'activities'>): Promise<number> {
  const h = doc.header;
  const { data, error } = await supabase().rpc('jsa_save', {
    p_id: doc.id, p_version: doc.version,
    p_header: {
      number: h.number, project: h.project, client: h.client, location: h.location, work_description: h.work_description,
      jsa_date: h.jsa_date, prepared_by: h.prepared_by, equipment: h.equipment,
      additional_instructions: h.additional_instructions, ai_instructions: h.ai_instructions,
    },
    p_activities: doc.activities,
  });
  if (error) throw new Error(error.message);
  return data as number;
}

export async function createJsa(header: Record<string, unknown> = {}, activities: JActivity[] = []): Promise<string> {
  const { data, error } = await supabase().rpc('jsa_create', { p_header: header, p_activities: activities });
  if (error) throw new Error(error.message);
  return data as string;
}

/* ---------------------------------------------------------------- settings */
export async function loadJsaSettings(): Promise<JsaSettings> {
  const rows = unwrap(await supabase().from('jsa_settings').select('key, value')) as { key: string; value: unknown }[];
  const s: Record<string, unknown> = { ...DEFAULT_JSA_SETTINGS };
  rows.forEach((r) => { s[r.key] = r.value; });
  const out = s as unknown as JsaSettings;
  if (!Array.isArray(out.hazard_categories) || !out.hazard_categories.length) out.hazard_categories = DEFAULT_JSA_SETTINGS.hazard_categories;
  if (!Array.isArray(out.export_templates) || !out.export_templates.length) out.export_templates = DEFAULT_JSA_SETTINGS.export_templates;
  return out;
}

export async function saveJsaSetting<K extends keyof JsaSettings>(key: K, value: JsaSettings[K]): Promise<void> {
  const { error } = await supabase().from('jsa_settings').upsert({ company_id: getCompanyId(), key, value, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' });
  if (error) throw new Error(error.message);
}

/* ---------------------------------------------------------------- AI routes */
async function headers(json = true): Promise<HeadersInit> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  const h: Record<string, string> = { authorization: `Bearer ${token}`, 'x-company-id': getCompanyId() ?? '' };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function readError(res: Response): Promise<string> {
  const b = await res.json().catch(() => null) as { error?: string } | null;
  return b?.error ?? (res.status === 413 ? 'The request was too large.' : `The server returned an error (${res.status}).`);
}

export async function aiStatus(): Promise<{ configured: boolean; provider: string | null; model: string | null }> {
  const res = await fetch('/api/jsa/generate', { headers: await headers(false) });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function aiPost<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try { res = await fetch('/api/jsa/generate', { method: 'POST', headers: await headers(), body: JSON.stringify(body), signal }); }
  catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    if (e instanceof Error && /session/i.test(e.message)) throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<T>;
}

export interface GenParams {
  activity: string; activityEquipment: string; activityInstructions: string;
  category: string; hazardName: string; hazardInstructions: string;
  equipment: string; instructions: string;
  job: { project: string; client: string; location: string; work_description: string; equipment: string; additional_instructions: string };
}
export interface GenOutcome { controls: string[]; flags: string[]; gaps: string[]; references: { id: string; work_activity: string; hazard: string }[]; error?: string }

/**
 * Generates `target` NEW controls for one hazard. Calls are made in chunks of at most 20 (keeps each request short);
 * `existing` controls are sent so the AI does not repeat them, and every returned control is de-duplicated again here,
 * so a retried or repeated request can never add the same control twice. Partial results are returned with `error` set.
 */
export async function generateControls(p: GenParams, existing: string[], target: number, signal?: AbortSignal): Promise<GenOutcome> {
  const got: string[] = [];
  const flags = new Set<string>(); const refs = new Map<string, { id: string; work_activity: string; hazard: string }>();
  let gaps: string[] = []; let dry = 0;
  const maxCalls = Math.ceil(target / 18) + 2;
  try {
    for (let call = 0; call < maxCalls && got.length < target && dry < 2; call++) {
      const need = Math.min(20, target - got.length);
      const r = await aiPost<{ controls: string[]; flags: string[]; gaps: string[]; references: { id: string; work_activity: string; hazard: string }[] }>(
        { task: 'controls', ...p, count: need, existing: [...existing, ...got].slice(-80) }, signal);
      const fresh = r.controls.filter((c) => !isDuplicate(c, [...existing, ...got]));
      fresh.forEach((c) => got.push(c));
      r.flags.forEach((f) => flags.add(f)); r.references.forEach((x) => refs.set(x.id, x)); gaps = r.gaps;
      dry = fresh.length === 0 ? dry + 1 : 0;
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { controls: got.slice(0, target), flags: [...flags], gaps, references: [...refs.values()], error: 'Cancelled' };
    return { controls: got.slice(0, target), flags: [...flags], gaps, references: [...refs.values()], error: e instanceof Error ? e.message : 'Generation failed' };
  }
  return { controls: got.slice(0, target), flags: [...flags], gaps, references: [...refs.values()] };
}

export async function refineControl(o: { text: string; action: 'shorten' | 'expand'; activity: string; hazardName: string; job: GenParams['job']; instructions?: string }): Promise<string> {
  return (await aiPost<{ text: string }>({ task: 'refine', ...o })).text;
}

export interface StructuredActivity { title: string; equipment: string; hazards: { name: string; controls: string[] }[] }
export async function structureText(text: string, categories: string[]): Promise<StructuredActivity[]> {
  return (await aiPost<{ activities: StructuredActivity[] }>({ task: 'structure', text: text.slice(0, 40000), categories })).activities;
}

export async function extractFile(file: File): Promise<{ text: string; truncated: boolean; name: string }> {
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch('/api/jsa/extract', { method: 'POST', headers: await headers(false), body: fd });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}
