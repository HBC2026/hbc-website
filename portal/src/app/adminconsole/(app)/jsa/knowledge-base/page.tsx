'use client';
import { useMemo, useRef, useState } from 'react';
import { AutoTextarea, JsaGuard } from '@/components/jsa/common';
import { useApp } from '@/components/Providers';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Select, SuggestInput } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { extractFile, structureText } from '@/lib/jsa/client';
import { matchCategory, parseActivities, splitItems } from '@/lib/jsa/parse';
import { hazardName, type JActivity, type KbEntry } from '@/lib/jsa/types';
import { useJsaSettings } from '@/lib/jsa/useSettings';
import { uniqueTexts } from '@/lib/jsa/dedupe';
import { supabase, unwrap } from '@/lib/supabase';

export default function KnowledgeBasePage() {
  return <JsaGuard><Inner /></JsaGuard>;
}

interface Draft { id?: string; work_activity: string; hazard: string; equipment: string; controls: string; applicable_rules: string; source: string; tags: string }
const blank = (): Draft => ({ work_activity: '', hazard: '', equipment: '', controls: '', applicable_rules: '', source: '', tags: '' });
const toDraft = (e: KbEntry): Draft => ({ id: e.id, work_activity: e.work_activity, hazard: e.hazard, equipment: e.equipment, controls: e.controls.join('\n'), applicable_rules: e.applicable_rules, source: e.source, tags: e.tags.join(', ') });
const fromDraft = (d: Draft) => ({
  work_activity: d.work_activity.trim(), hazard: d.hazard.trim(), equipment: d.equipment.trim(), controls: uniqueTexts(splitItems(d.controls)),
  applicable_rules: d.applicable_rules.trim(), source: d.source.trim(), tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
});

function Inner() {
  const { toast, confirmDialog } = useApp();
  const sb = supabase();
  const { settings } = useJsaSettings();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'approved' | 'archived'>('approved');
  const [hz, setHz] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('safety_knowledge_base').select('*').order('updated_at', { ascending: false }).limit(3000)) as KbEntry[], []);

  const hazards = useMemo(() => Array.from(new Set((data ?? []).map((e) => e.hazard).filter(Boolean))).sort(), [data]);
  const rows = useMemo(() => (data ?? []).filter((e) => e.status === status && (!hz || e.hazard === hz) &&
    `${e.work_activity} ${e.hazard} ${e.equipment} ${e.tags.join(' ')} ${e.controls.join(' ')}`.toLowerCase().includes(q.toLowerCase())), [data, q, status, hz]);

  async function save() {
    if (!draft) return;
    const v = fromDraft(draft);
    if (!v.work_activity || !v.hazard) return toast('Work activity and hazard are required', true);
    if (!v.controls.length) return toast('Add at least one control measure', true);
    const res = draft.id ? await sb.from('safety_knowledge_base').update(v).eq('id', draft.id) : await sb.from('safety_knowledge_base').insert([{ ...v, status: 'approved' }]);
    if (res.error) return toast(res.error.message, true);
    toast(draft.id ? 'Entry updated (previous version kept)' : 'Entry added as approved'); setDraft(null); reload();
  }
  async function setState(e: KbEntry, s: 'approved' | 'archived') {
    const { error } = await sb.from('safety_knowledge_base').update({ status: s }).eq('id', e.id);
    if (error) return toast(error.message, true);
    toast(s === 'archived' ? 'Archived — no longer used by the AI' : 'Restored'); reload();
  }
  async function remove(e: KbEntry) {
    if (!(await confirmDialog({ title: 'Delete entry permanently?', message: `“${e.work_activity} — ${e.hazard}” and its revision history will be deleted. Archive it instead if you may need it again.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.from('safety_knowledge_base').delete().eq('id', e.id);
    if (error) return toast(error.message, true);
    toast('Entry deleted'); reload();
  }

  return (
    <>
      <PageHead eyebrow="JSA Management" title="Safety Knowledge Base" sub="Administrator-approved control measures. The AI uses these as approved references when it writes new JSAs.">
        <button className="btn" onClick={() => setImporting(true)}>⬆ Import Word / PDF</button>
        <button className="btn primary" onClick={() => setDraft(blank())}>＋ Add entry</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="banner">Only entries you confirm here become approved references. Unreviewed AI output is never saved automatically. Use “To library” on a hazard in the JSA Editor to add reviewed controls from a completed JSA.</div>
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" style={{ minWidth: 260 }} placeholder="Search activity, hazard, equipment, tag, control…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="select" value={hz} onChange={(e) => setHz(e.target.value)} aria-label="Hazard"><option value="">All hazards</option>{hazards.map((h) => <option key={h} value={h}>{h}</option>)}</Select>
            <Select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status"><option value="approved">Approved</option><option value="archived">Archived</option></Select>
          </div>
          <span className="muted">{rows.length} entries</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Work Activity</th><th>Hazard</th><th>Equipment / Tools</th><th>Controls</th><th>Tags</th><th>Source JSA</th><th>Added</th><th>Last modified</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="strong">{e.work_activity}</td><td>{e.hazard}</td><td>{e.equipment || <span className="muted">—</span>}</td>
                  <td>{e.controls.length}</td>
                  <td>{e.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                  <td>{e.source || <span className="muted">—</span>}</td>
                  <td>{fmtDate(e.created_at)}</td><td>{fmtDateTime(e.updated_at)}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn sm" onClick={() => setDraft(toDraft(e))}>Edit</button>{' '}
                    <button className="btn sm" onClick={() => setState(e, e.status === 'approved' ? 'archived' : 'approved')}>{e.status === 'approved' ? 'Archive' : 'Restore'}</button>{' '}
                    <button className="btn sm danger" onClick={() => remove(e)}>Delete</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9}><div className="empty">{status === 'approved' ? 'No approved entries yet. Add one, import a previous JSA, or save reviewed controls from the JSA Editor.' : 'No archived entries.'}</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      {draft && <EntryModal draft={draft} setDraft={setDraft} categories={settings.hazard_categories} onSave={save} onRestored={reload} />}
      {importing && <ImportModal categories={settings.hazard_categories} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); reload(); }} />}
    </>
  );
}

function EntryModal({ draft, setDraft, categories, onSave, onRestored }: { draft: Draft; setDraft: (d: Draft | null) => void; categories: string[]; onSave: () => void; onRestored: () => void }) {
  const sb = supabase();
  const { toast } = useApp();
  const set = (k: keyof Draft, v: string) => setDraft({ ...draft, [k]: v });
  const revs = useQuery(async () => draft.id ? unwrap(await sb.from('safety_kb_revisions').select('id, created_at, snapshot').eq('kb_id', draft.id).order('created_at', { ascending: false }).limit(30)) as { id: string; created_at: string; snapshot: KbEntry }[] : [], [draft.id]);
  const n = splitItems(draft.controls).length;
  async function restore(s: KbEntry) {
    const { error } = await sb.from('safety_knowledge_base').update({ work_activity: s.work_activity, hazard: s.hazard, equipment: s.equipment, controls: s.controls, applicable_rules: s.applicable_rules, source: s.source, tags: s.tags }).eq('id', draft.id!);
    if (error) return toast(error.message, true);
    toast('Earlier version restored (the current one was kept in history)'); onRestored(); setDraft(null);
  }
  return (
    <Modal wide title={draft.id ? 'Edit knowledge base entry' : 'New knowledge base entry'} onClose={() => setDraft(null)}
      footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" onClick={onSave}>{draft.id ? 'Save changes' : 'Save as approved'}</button></>}>
      <div className="form-grid">
        <Field className="span-2" label="Work Activity"><input className="input" autoFocus value={draft.work_activity} onChange={(e) => set('work_activity', e.target.value)} /></Field>
        <Field label="Hazard"><SuggestInput value={draft.hazard} options={categories} onChange={(v) => set('hazard', v)} /></Field>
        <Field className="span-3" label="Equipment / Tools"><input className="input" value={draft.equipment} onChange={(e) => set('equipment', e.target.value)} /></Field>
        <Field className="span-3" label={`Approved Control Measures (one per line) — ${n} controls`}><AutoTextarea minRows={8} value={draft.controls} onChange={(v) => set('controls', v)} /></Field>
        <Field className="span-3" label="Applicable Safety Rules"><AutoTextarea minRows={2} value={draft.applicable_rules} onChange={(v) => set('applicable_rules', v)} placeholder="Site / client rules these controls rely on" /></Field>
        <Field className="span-2" label="Source JSA"><input className="input" value={draft.source} onChange={(e) => set('source', e.target.value)} placeholder="e.g. JSA-2026-004 Rev 1" /></Field>
        <Field label="Tags (comma separated)"><input className="input" value={draft.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
      </div>
      {(revs.data ?? []).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Revision history</div>
          {(revs.data ?? []).map((r) => (
            <div key={r.id} className="jsa-list-row"><span>{fmtDateTime(r.created_at)} · {r.snapshot.controls?.length ?? 0} controls</span><button className="btn sm" onClick={() => restore(r.snapshot)}>Restore this version</button></div>
          ))}
        </div>
      )}
    </Modal>
  );
}

interface Candidate { key: number; on: boolean; activity: string; hazard: string; equipment: string; controls: string }

function toCandidates(acts: JActivity[]): Candidate[] {
  let k = 0;
  return acts.flatMap((a) => a.hazards.filter((h) => h.controls.length).map((h) => ({
    key: k++, on: true, activity: a.title, hazard: hazardName(h), equipment: a.equipment, controls: h.controls.map((c) => c.text).join('\n'),
  })));
}

function ImportModal({ categories, onClose, onSaved }: { categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [note, setNote] = useState('');

  async function read(f: File) {
    setBusy(true); setNote('');
    try {
      const r = await extractFile(f);
      setName(r.name); setText(r.text);
      const parsed = parseActivities(r.text, categories);
      const c = toCandidates(parsed.activities);
      setCands(c);
      setNote(c.length ? `Found ${c.length} hazard${c.length === 1 ? '' : 's'} with control measures. Review before saving.${r.truncated ? ' (Long document: only the first part was read.)' : ''}` : 'No table of activities, hazards and controls was recognised automatically. Try “Recognise with AI”.');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }
  async function ai() {
    setBusy(true);
    try {
      const acts = await structureText(text, categories);
      const mapped: JActivity[] = acts.map((a) => ({ id: '', title: a.title, equipment: a.equipment, instructions: '', hazards: a.hazards.map((h) => ({ id: '', category: matchCategory(h.name, categories).category, custom_name: h.name, instructions: '', controls: h.controls.map((c) => ({ id: '', text: c, origin: 'manual' as const, edited: false })) })) }));
      setCands(toCandidates(mapped)); setNote('Structured by AI — check every entry; the AI may misread tables.');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }
  const patch = (k: number, p: Partial<Candidate>) => setCands((c) => c!.map((x) => (x.key === k ? { ...x, ...p } : x)));
  async function save() {
    const chosen = (cands ?? []).filter((c) => c.on && c.activity.trim() && c.hazard.trim() && splitItems(c.controls).length);
    if (!chosen.length) return toast('Nothing selected to save', true);
    const { error } = await supabase().from('safety_knowledge_base').insert(chosen.map((c) => ({
      work_activity: c.activity.trim(), hazard: c.hazard.trim(), equipment: c.equipment.trim(), controls: uniqueTexts(splitItems(c.controls)), source: name, status: 'approved',
    })));
    if (error) return toast(error.message, true);
    toast(`${chosen.length} entries saved as approved`); onSaved();
  }
  return (
    <Modal wide title="Import previous JSA (Word / PDF)" onClose={onClose}
      footer={cands ? <><button className="btn" onClick={() => setCands(null)}>← Back</button><button className="btn primary" disabled={!cands.some((c) => c.on)} onClick={save}>Save {cands.filter((c) => c.on).length} as approved</button></> : undefined}>
      {!cands ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Upload a previously prepared JSA (.docx, text-based PDF). Its text is extracted on the server and treated as untrusted data; nothing is saved until you review it.</p>
          <input ref={file} type="file" accept=".docx,.pdf,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ''; }} />
          <div className="dropzone" onClick={() => file.current?.click()} role="button" tabIndex={0}>
            <div className="dropzone-icon">⬆</div><div className="dropzone-title">{busy ? 'Reading…' : 'Choose a Word or PDF file'}</div><div className="muted">Up to 4 MB</div>
          </div>
        </>
      ) : (
        <>
          {note && <div className="banner warn">{note}</div>}
          {text && <div style={{ marginBottom: 10 }}><button className="btn sm" disabled={busy} onClick={ai}>{busy ? 'Reading…' : '✦ Recognise with AI'}</button></div>}
          <div className="banner">Only content you tick and save becomes an approved reference. Fix wording, hazards and controls first.</div>
          {cands.map((c) => (
            <div key={c.key} className={`jsa-review${c.on ? '' : ' off'}`}>
              <label className="jsa-check"><input type="checkbox" checked={c.on} onChange={(e) => patch(c.key, { on: e.target.checked })} /> Include</label>
              <div className="form-grid">
                <Field className="span-2" label="Work Activity"><input className="input" value={c.activity} onChange={(e) => patch(c.key, { activity: e.target.value })} /></Field>
                <Field label="Hazard"><input className="input" value={c.hazard} onChange={(e) => patch(c.key, { hazard: e.target.value })} /></Field>
                <Field className="span-3" label="Equipment / Tools"><input className="input" value={c.equipment} onChange={(e) => patch(c.key, { equipment: e.target.value })} /></Field>
                <Field className="span-3" label={`Controls (${splitItems(c.controls).length})`}><AutoTextarea minRows={4} value={c.controls} onChange={(v) => patch(c.key, { controls: v })} /></Field>
              </div>
            </div>
          ))}
          {cands.length === 0 && <div className="empty">Nothing recognised.</div>}
        </>
      )}
    </Modal>
  );
}
