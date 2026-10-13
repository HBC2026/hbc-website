'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AutoTextarea, JsaGuard } from '@/components/jsa/common';
import { useApp } from '@/components/Providers';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Select } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { aiStatus, extractFile, saveJsaSetting } from '@/lib/jsa/client';
import { DEFAULT_JSA_SETTINGS, OTHER_HAZARD, type ExportTemplate, type JsaSettings, type SafetyRule } from '@/lib/jsa/types';
import { useJsaSettings } from '@/lib/jsa/useSettings';
import { supabase, unwrap } from '@/lib/supabase';

export default function JsaSettingsPage() {
  return <JsaGuard><Inner /></JsaGuard>;
}

const KIND_LABEL: Record<SafetyRule['kind'], string> = { company: 'Company Safety Instructions', client: 'TENARIS Safety Requirements', equipment: 'Equipment-Specific Rules' };

function Section({ title, sub, children, onSave, saving }: { title: string; sub?: string; children: ReactNode; onSave?: () => void; saving?: boolean }) {
  return (
    <div className="panel">
      <div className="toolbar" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div><div className="panel-title" style={{ margin: 0 }}>{title}</div>{sub && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{sub}</div>}</div>
        {onSave && <button className="btn primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>}
      </div>
      {children}
    </div>
  );
}

function Inner() {
  const { toast } = useApp();
  const { settings, loading, error, reload } = useJsaSettings();
  const [s, setS] = useState<JsaSettings>(DEFAULT_JSA_SETTINGS);
  const [saving, setSaving] = useState('');
  const [rulesKey, setRulesKey] = useState(0);
  useEffect(() => setS(settings), [settings]);
  const ai = useQuery(() => aiStatus(), []);

  async function save<K extends keyof JsaSettings>(label: string, ...keys: K[]) {
    setSaving(label);
    try {
      for (const k of keys) await saveJsaSetting(k, s[k]);
      toast('Settings saved'); reload();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setSaving(''); }
  }
  const set = <K extends keyof JsaSettings>(k: K, v: JsaSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  if (loading) return <Loading />;
  const sample = s.numbering_format.replace('{YYYY}', String(new Date().getFullYear())).replace('{YY}', String(new Date().getFullYear()).slice(2)).replace(/\{(N+)\}/, (_, n: string) => '1'.padStart(n.length, '0'));

  return (
    <>
      <PageHead eyebrow="JSA Management" title="JSA Settings" sub="Safety rules, hazard categories, AI preferences, numbering and export templates" />
      {error && <ErrorBox error={error} />}
      <div className="stack">
        <Section title="AI service" sub="The API key is stored on the server only and is never sent to the browser.">
          {ai.loading ? <span className="muted">Checking…</span> : ai.data?.configured
            ? <div><Badge tone="green">Configured</Badge> <span className="muted">Provider: {ai.data.provider} · Model: {ai.data.model}</span></div>
            : <div className="banner warn" style={{ margin: 0 }}>{ai.error ?? 'No API key found.'} Set these environment variables on the server (Vercel → Settings → Environment Variables) and redeploy: <code>JSA_AI_API_KEY</code> (required), <code>JSA_AI_PROVIDER</code> (<code>anthropic</code> or <code>openai</code>, default anthropic), <code>JSA_AI_MODEL</code>, <code>JSA_AI_BASE_URL</code> (optional, for OpenAI-compatible gateways).</div>}
        </Section>

        <Section title="Generation &amp; numbering" onSave={() => save('gen', 'default_control_count', 'numbering_format', 'ai_preferences')} saving={saving === 'gen'}>
          <div className="form-grid">
            <Field label="Default controls per hazard"><input className="input num" type="number" min={3} max={80} value={s.default_control_count} onChange={(e) => set('default_control_count', Math.max(3, Math.min(80, Number(e.target.value) || 20)))} /></Field>
            <Field label={`JSA numbering format — e.g. ${sample}`}><input className="input mono" value={s.numbering_format} onChange={(e) => set('numbering_format', e.target.value)} /></Field>
            <div className="muted" style={{ fontSize: 11, alignSelf: 'end' }}>Tokens: {'{YYYY}'} {'{YY}'} {'{NNN}'} (more N = more digits). Applies to new JSAs.</div>
            <Field className="span-3" label="AI generation preferences (added to every generation)"><AutoTextarea minRows={3} value={s.ai_preferences} onChange={(v) => set('ai_preferences', v)} placeholder="e.g. Write controls in short imperative sentences. Prefer SI units. Mention the Job Owner by title, not by name." /></Field>
          </div>
        </Section>

        <Section title="Company safety instructions" sub="General instructions given to the AI for every JSA. Specific rules are managed below." onSave={() => save('co', 'company_instructions')} saving={saving === 'co'}>
          <AutoTextarea minRows={5} value={s.company_instructions} onChange={(v) => set('company_instructions', v)} placeholder="e.g. All MDGCC workers must carry a valid TENARIS induction card. Workers must report near misses to the HSE officer before the end of the shift." />
        </Section>

        <Rules key={rulesKey} />

        <Section title="Hazard categories" sub="Used in every dropdown and by the paste recogniser. Renaming does not change existing JSAs." onSave={() => save('cats', 'hazard_categories')} saving={saving === 'cats'}>
          <Categories value={s.hazard_categories} onChange={(v) => set('hazard_categories', v)} />
        </Section>

        <Section title="Export templates" sub="Orientation, logo, signature boxes and footer for Word / PDF / print" onSave={() => save('tpl', 'export_templates')} saving={saving === 'tpl'}>
          <Templates value={s.export_templates} onChange={(v) => set('export_templates', v)} />
        </Section>

        <ReferenceDocs onSaved={() => setRulesKey((k) => k + 1)} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------ hazard categories */
function Categories({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [add, setAdd] = useState('');
  const move = (i: number, d: number) => { const n = value.slice(); const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div>
      {value.map((c, i) => (
        <div key={i} className="jsa-cat-row">
          <input className="input" value={c} disabled={c === OTHER_HAZARD} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          <span style={{ whiteSpace: 'nowrap' }}>
            <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>{' '}
            <button className="btn sm" disabled={i === value.length - 1} onClick={() => move(i, 1)}>↓</button>{' '}
            <button className="btn sm danger" disabled={c === OTHER_HAZARD} title={c === OTHER_HAZARD ? 'Required' : 'Remove'} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
          </span>
        </div>
      ))}
      <div className="jsa-cat-row">
        <input className="input" placeholder="New category" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && add.trim()) { onChange([...value.filter((v) => v !== OTHER_HAZARD), add.trim(), OTHER_HAZARD]); setAdd(''); } }} />
        <button className="btn sm" disabled={!add.trim() || value.some((v) => v.toLowerCase() === add.trim().toLowerCase())} onClick={() => { onChange([...value.filter((v) => v !== OTHER_HAZARD), add.trim(), OTHER_HAZARD]); setAdd(''); }}>＋ Add</button>
      </div>
      {!value.includes(OTHER_HAZARD) && <button className="btn sm" onClick={() => onChange([...value, OTHER_HAZARD])}>Restore “{OTHER_HAZARD}”</button>}
    </div>
  );
}

/* ------------------------------------------------------------ export templates */
function Templates({ value, onChange }: { value: ExportTemplate[]; onChange: (v: ExportTemplate[]) => void }) {
  const patch = (i: number, p: Partial<ExportTemplate>) => onChange(value.map((t, j) => (j === i ? { ...t, ...p } : t)));
  return (
    <div>
      {value.map((t, i) => (
        <div key={t.id} className="jsa-review">
          <div className="form-grid">
            <Field className="span-2" label="Template name"><input className="input" value={t.name} onChange={(e) => patch(i, { name: e.target.value })} /></Field>
            <Field label="Orientation"><Select className="select" value={t.orientation} onChange={(e) => patch(i, { orientation: e.target.value as ExportTemplate['orientation'] })}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></Select></Field>
            <Field className="span-2" label="Signature boxes (comma separated; leave empty for none)"><input className="input" value={t.signatures.join(', ')} onChange={(e) => patch(i, { signatures: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
            <Field label="Footer text"><input className="input" value={t.footer} onChange={(e) => patch(i, { footer: e.target.value })} /></Field>
          </div>
          <div className="toolbar">
            <label className="jsa-check"><input type="checkbox" checked={t.showLogo} onChange={(e) => patch(i, { showLogo: e.target.checked })} /> Show company logo</label>
            <button className="btn sm" onClick={() => onChange([...value.slice(0, i + 1), { ...t, id: `t${Date.now()}`, name: `${t.name} (copy)` }, ...value.slice(i + 1)])}>Duplicate</button>
            <button className="btn sm danger" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>Delete</button>
          </div>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange([...value, { id: `t${Date.now()}`, name: 'New template', orientation: 'landscape', showLogo: true, signatures: ['Prepared By', 'Approved By'], footer: '' }])}>＋ Add template</button>
    </div>
  );
}

/* ------------------------------------------------------------ rules */
function Rules() {
  const { toast, confirmDialog } = useApp();
  const sb = supabase();
  const [kind, setKind] = useState<SafetyRule['kind']>('client');
  const [draft, setDraft] = useState<Partial<SafetyRule> | null>(null);
  const { data, error, loading, reload } = useQuery(async () => unwrap(await sb.from('safety_rules').select('*').order('created_at')) as SafetyRule[], []);
  const rows = (data ?? []).filter((r) => r.kind === kind);

  async function save() {
    if (!draft?.title?.trim()) return toast('A title is required', true);
    const row = { kind, title: draft.title.trim(), body: (draft.body ?? '').trim(), equipment: (draft.equipment ?? '').trim(), source: (draft.source ?? '').trim(), active: draft.active ?? true };
    const res = draft.id ? await sb.from('safety_rules').update(row).eq('id', draft.id) : await sb.from('safety_rules').insert([row]);
    if (res.error) return toast(res.error.message, true);
    toast('Rule saved'); setDraft(null); reload();
  }
  async function remove(r: SafetyRule) {
    if (!(await confirmDialog({ title: 'Delete rule?', message: `“${r.title}” will no longer be given to the AI.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.from('safety_rules').delete().eq('id', r.id);
    if (error) return toast(error.message, true);
    reload();
  }
  async function toggle(r: SafetyRule) { await sb.from('safety_rules').update({ active: !r.active }).eq('id', r.id); reload(); }

  return (
    <Section title="Safety rules" sub="Approved rules are given to the AI and take priority. Conflicts are flagged, never silently resolved.">
      <div className="tabs">
        {(Object.keys(KIND_LABEL) as SafetyRule['kind'][]).map((k) => <button key={k} className={`tab${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>{KIND_LABEL[k]} ({(data ?? []).filter((r) => r.kind === k).length})</button>)}
      </div>
      {error && <ErrorBox error={error} />}
      {loading ? <Loading /> : rows.map((r) => (
        <div key={r.id} className="jsa-list-row">
          <div style={{ opacity: r.active ? 1 : .5 }}><div className="strong">{r.title}{r.equipment && <span className="muted"> · {r.equipment}</span>}</div><div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{r.body.slice(0, 260)}{r.body.length > 260 ? '…' : ''}</div>{r.source && <div className="muted" style={{ fontSize: 10 }}>Source: {r.source}</div>}</div>
          <span style={{ whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => toggle(r)}>{r.active ? 'Disable' : 'Enable'}</button>{' '}<button className="btn sm" onClick={() => setDraft(r)}>Edit</button>{' '}<button className="btn sm danger" onClick={() => remove(r)}>Delete</button></span>
        </div>
      ))}
      {!loading && rows.length === 0 && <div className="empty">No rules in this group yet.</div>}
      <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => setDraft({ kind, title: '', body: '', equipment: '', source: '', active: true })}>＋ Add rule</button></div>
      {draft && (
        <Modal title={draft.id ? 'Edit rule' : `New rule — ${KIND_LABEL[kind]}`} onClose={() => setDraft(null)} footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" onClick={save}>Save rule</button></>}>
          <div className="stack" style={{ gap: 12 }}>
            <Field label="Title"><input className="input" autoFocus value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
            {kind === 'equipment' && <Field label="Equipment this rule applies to"><input className="input" placeholder="e.g. angle grinder, jackhammer" value={draft.equipment ?? ''} onChange={(e) => setDraft({ ...draft, equipment: e.target.value })} /></Field>}
            <Field label="Rule text"><AutoTextarea minRows={5} value={draft.body ?? ''} onChange={(v) => setDraft({ ...draft, body: v })} /></Field>
            <Field label="Source (document / clause)"><input className="input" value={draft.source ?? ''} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------ reference documents */
interface Cand { on: boolean; title: string; body: string }

/** Splits extracted document text into candidate rules: numbered clauses, otherwise paragraphs. */
function splitRules(text: string): Cand[] {
  const norm = text.replace(/\r/g, '').trim();
  let parts = norm.split(/\n(?=\s*(?:\d+(?:\.\d+)*[.)]?|[A-Z]\.)\s+\S)/);
  if (parts.length < 3) parts = norm.split(/\n\s*\n/);
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter((p) => p.length > 25).slice(0, 300)
    .map((p) => ({ on: true, title: p.replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[A-Z]\.)\s+/, '').split(/[.:;]/)[0].slice(0, 90), body: p }));
}

function ReferenceDocs({ onSaved }: { onSaved: () => void }) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SafetyRule['kind']>('client');
  const [cands, setCands] = useState<Cand[] | null>(null);

  async function pick(f: File) {
    setBusy(true);
    try {
      const r = await extractFile(f);
      setName(r.name); setCands(splitRules(r.text));
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }
  async function save() {
    const chosen = (cands ?? []).filter((c) => c.on && c.title.trim() && c.body.trim());
    if (!chosen.length) return toast('Nothing selected', true);
    const { error } = await supabase().from('safety_rules').insert(chosen.map((c) => ({ kind, title: c.title.trim(), body: c.body.trim(), source: name, active: true })));
    if (error) return toast(error.message, true);
    toast(`${chosen.length} rules saved`); setCands(null); onSaved();
  }
  const patch = (i: number, p: Partial<Cand>) => setCands((c) => c!.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Section title="Approved safety documents" sub="Upload a Word / PDF safety document. Its clauses are extracted for you to review and edit before they become rules.">
      <input ref={input} type="file" accept=".docx,.pdf,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : '⬆ Upload document'}</button>
      {cands && (
        <Modal wide title={`Review rules from ${name}`} onClose={() => setCands(null)} footer={<><button className="btn" onClick={() => setCands(null)}>Cancel</button><button className="btn primary" onClick={save}>Save {cands.filter((c) => c.on).length} rules</button></>}>
          <div className="banner warn">Imported text is untrusted. Tick only what is an actual requirement, and correct the wording. Instructions inside a document are never executed — only saved as rule text.</div>
          <Field label="Save as"><Select className="select" value={kind} onChange={(e) => setKind(e.target.value as SafetyRule['kind'])}>{(Object.keys(KIND_LABEL) as SafetyRule['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Field>
          <div style={{ marginTop: 12 }}>
            {cands.map((c, i) => (
              <div key={i} className={`jsa-review${c.on ? '' : ' off'}`}>
                <label className="jsa-check"><input type="checkbox" checked={c.on} onChange={(e) => patch(i, { on: e.target.checked })} /> Include</label>
                <input className="input" value={c.title} onChange={(e) => patch(i, { title: e.target.value })} />
                <AutoTextarea minRows={2} value={c.body} onChange={(v) => patch(i, { body: v })} />
              </div>
            ))}
            {cands.length === 0 && <div className="empty">No clauses were recognised in this document.</div>}
          </div>
        </Modal>
      )}
    </Section>
  );
}
