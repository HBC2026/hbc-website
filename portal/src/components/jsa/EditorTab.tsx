'use client';
import { memo, useState } from 'react';
import { Badge, Modal, Select } from '@/components/ui';
import { useApp } from '@/components/Providers';
import { isDuplicate } from '@/lib/jsa/dedupe';
import { refineControl } from '@/lib/jsa/client';
import { splitItems } from '@/lib/jsa/parse';
import { coverageGaps } from '@/lib/jsa/validate';
import type { Generator } from '@/lib/jsa/useGenerator';
import { paramsFor } from '@/lib/jsa/useGenerator';
import type { JsaEditor } from '@/lib/jsa/useJsaDoc';
import { hazardName, newActivity, newControl, newHazard, OTHER_HAZARD, uid, type JActivity, type JControl, type JHazard, type JsaSettings } from '@/lib/jsa/types';
import { supabase } from '@/lib/supabase';
import { AutoTextarea } from './common';

type Drag = { kind: 'control'; hid: string; cid: string } | { kind: 'activity'; aid: string };
let dragging: Drag | null = null;

/** Moves a control (possibly into another hazard) to `index` of the destination hazard. */
function moveControl(ed: JsaEditor, from: { hid: string; cid: string }, toHid: string, index: number) {
  ed.update((d) => {
    const hs = d.activities.flatMap((a) => a.hazards);
    const src = hs.find((h) => h.id === from.hid); const dst = hs.find((h) => h.id === toHid);
    if (!src || !dst) return;
    const i = src.controls.findIndex((c) => c.id === from.cid); if (i < 0) return;
    const [c] = src.controls.splice(i, 1);
    const at = src === dst && i < index ? index - 1 : index;
    dst.controls.splice(Math.max(0, Math.min(at, dst.controls.length)), 0, c);
  });
}
function moveActivity(ed: JsaEditor, aid: string, index: number) {
  ed.update((d) => {
    const i = d.activities.findIndex((a) => a.id === aid); if (i < 0) return;
    const [a] = d.activities.splice(i, 1);
    d.activities.splice(i < index ? index - 1 : index, 0, a);
  });
}

export function EditorTab({ ed, gen, settings }: { ed: JsaEditor; gen: Generator; settings: JsaSettings }) {
  const doc = ed.doc!;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [overAct, setOverAct] = useState<string | null>(null);
  const total = doc.activities.reduce((n, a) => n + a.hazards.reduce((m, h) => m + h.controls.length, 0), 0);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });

  return (
    <div className="stack">
      {ed.locked && <div className="banner">This JSA is finalized and read-only. Use “New revision” in the History tab to edit it.</div>}
      {gen.running && <div className="banner ok">✦ Generating controls… <button className="btn sm" onClick={gen.cancel}>Cancel</button></div>}
      <div className="toolbar">
        <span className="muted">{doc.activities.length} activities · {total} control measures · drag ⠿ to reorder · numbering is automatic</span>
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setCollapsed(new Set(doc.activities.map((a) => a.id)))}>Collapse all</button>
        <button className="btn sm" onClick={() => setCollapsed(new Set())}>Expand all</button>
      </div>

      {doc.activities.map((a, ai) => (
        <div key={a.id} className={`jsa-act${overAct === a.id ? ' over' : ''}`}
          onDragOver={(e) => { if (dragging?.kind === 'activity') { e.preventDefault(); setOverAct(a.id); } }}
          onDragLeave={() => setOverAct((o) => (o === a.id ? null : o))}
          onDrop={(e) => { if (dragging?.kind === 'activity') { e.preventDefault(); moveActivity(ed, dragging.aid, ai); dragging = null; } setOverAct(null); }}>
          <ActivityHeader ed={ed} a={a} index={ai} collapsed={collapsed.has(a.id)} onToggle={() => toggle(a.id)} />
          {!collapsed.has(a.id) && a.hazards.map((h) => (
            <HazardBlock key={h.id} ed={ed} gen={gen} settings={settings} a={a} h={h} />
          ))}
          {!collapsed.has(a.id) && !ed.locked && (
            <div style={{ padding: '0 16px 14px' }}><button className="btn sm" onClick={() => ed.update((d) => { d.activities[ai].hazards.push(newHazard()); })}>＋ Add hazard</button></div>
          )}
        </div>
      ))}
      {!ed.locked && <div><button className="btn" onClick={() => ed.update((d) => { d.activities.push(newActivity()); })}>＋ Add work activity</button></div>}
      {doc.activities.length === 0 && <div className="panel"><div className="empty">No activities yet. Add them in the Activities &amp; Hazards tab or click “Add work activity”.</div></div>}
    </div>
  );
}

function ActivityHeader({ ed, a, index, collapsed, onToggle }: { ed: JsaEditor; a: JActivity; index: number; collapsed: boolean; onToggle: () => void }) {
  const { confirmDialog } = useApp();
  const n = a.hazards.reduce((m, h) => m + h.controls.length, 0);
  async function remove() {
    if (n > 0 && !(await confirmDialog({ title: 'Delete activity?', message: `“${a.title || 'Untitled'}” and its ${n} control measures will be removed. You can undo this.`, confirmLabel: 'Delete', danger: true }))) return;
    ed.update((d) => { d.activities = d.activities.filter((x) => x.id !== a.id); });
  }
  const duplicate = () => ed.update((d) => {
    const i = d.activities.findIndex((x) => x.id === a.id);
    const copy = { ...JSON.parse(JSON.stringify(a)), id: uid(), title: a.title ? `${a.title} (copy)` : '' } as JActivity;
    copy.hazards.forEach((h) => { h.id = uid(); h.controls.forEach((c) => { c.id = uid(); }); });
    d.activities.splice(i + 1, 0, copy);
  });
  return (
    <div className="jsa-act-head">
      {!ed.locked && <span className="jsa-handle" draggable title="Drag to reorder activities"
        onDragStart={(e) => { dragging = { kind: 'activity', aid: a.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id); }}
        onDragEnd={() => { dragging = null; }}>⠿</span>}
      <button className="jsa-twist" onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '▸' : '▾'}</button>
      <span className="jsa-act-no">{index + 1}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <AutoTextarea className="textarea jsa-title" disabled={ed.locked} value={a.title} placeholder="Work activity" onChange={(v) => ed.update((d) => { d.activities[index].title = v; }, `t-${a.id}`)} />
        {!collapsed && <input className="input" style={{ marginTop: 6 }} disabled={ed.locked} placeholder="Equipment / tools for this activity" value={a.equipment} onChange={(e) => ed.update((d) => { d.activities[index].equipment = e.target.value; }, `e-${a.id}`)} />}
      </div>
      <span className="muted">{n} controls</span>
      {!ed.locked && <span style={{ whiteSpace: 'nowrap' }}>
        <button className="btn sm" title="Duplicate activity" onClick={duplicate}>⧉</button>{' '}
        <button className="btn sm danger" title="Delete activity" onClick={remove}>🗑</button>
      </span>}
    </div>
  );
}

function HazardBlock({ ed, gen, settings, a, h }: { ed: JsaEditor; gen: Generator; settings: JsaSettings; a: JActivity; h: JHazard }) {
  const { toast, confirmDialog } = useApp();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [paste, setPaste] = useState(false);
  const job = gen.jobs[h.id];
  const gaps = h.controls.length >= 8 ? coverageGaps(h.category, h.controls.map((c) => c.text)) : [];
  const cats = settings.hazard_categories.includes(h.category) ? settings.hazard_categories : [...settings.hazard_categories, h.category];
  const upd = (fn: (hz: { category: string; custom_name: string; controls: JControl[] }) => void, key?: string) =>
    ed.update((d) => { const hz = d.activities.flatMap((x) => x.hazards).find((x) => x.id === h.id); if (hz) fn(hz); }, key);

  async function removeHazard() {
    if (h.controls.length && !(await confirmDialog({ title: 'Remove hazard?', message: `This hazard and its ${h.controls.length} control measures will be removed. You can undo this.`, confirmLabel: 'Remove', danger: true }))) return;
    ed.update((d) => { const ac = d.activities.find((x) => x.id === a.id); if (ac) ac.hazards = ac.hazards.filter((x) => x.id !== h.id); });
  }
  async function copy() {
    const text = h.controls.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    try { await navigator.clipboard.writeText(`${a.title} — ${hazardName(h)}\n${text}`); toast(`${h.controls.length} controls copied`); } catch { toast('Copy is not available in this browser', true); }
  }
  async function toKb() {
    if (!(await confirmDialog({ title: 'Save to Safety Knowledge Base?', message: `Save these ${h.controls.length} controls as approved reference material? Only do this for controls you have reviewed and confirmed. The AI will use them as approved company references for similar future work.`, confirmLabel: 'Save as approved' }))) return;
    if (!(await ed.save())) return toast('Save the JSA first (see the error at the top).', true);
    const { error } = await supabase().rpc('jsa_to_kb', { p_hazard: h.id });
    if (error) return toast(error.message, true);
    toast('Saved to the Safety Knowledge Base');
  }
  const selectAll = sel.size === h.controls.length && h.controls.length > 0;

  return (
    <div className="jsa-haz">
      <div className="jsa-haz-head">
        <div className="jsa-haz-title">
          <Select className="select" value={h.category} disabled={ed.locked} onChange={(e) => upd((hz) => { hz.category = e.target.value; })}>
            {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <input className="input" disabled={ed.locked} value={h.custom_name} placeholder={h.category === OTHER_HAZARD ? 'Describe the hazard' : 'Specific wording (optional)'} onChange={(e) => upd((hz) => { hz.custom_name = e.target.value; }, `hn-${h.id}`)} />
        </div>
        <div className="jsa-haz-actions">
          {job && job.status !== 'done' && job.status !== 'skipped' && <Badge tone={job.status === 'error' ? 'red' : 'blue'}>{job.status === 'running' ? 'Generating…' : job.status === 'queued' ? 'Queued' : job.status === 'error' ? 'Failed' : 'Cancelled'}</Badge>}
          {!ed.locked && <>
            <button className="btn sm" disabled={gen.running} title="Generate controls to reach the default count (keeps existing ones)" onClick={() => gen.run([h.id], { mode: 'fill' })}>✦ Generate</button>
            <button className="btn sm" disabled={gen.running} title="Add more controls" onClick={() => gen.run([h.id], { mode: 'add_more', count: 8 })}>＋ 8 more</button>
            {sel.size > 0 && <button className="btn sm" disabled={gen.running} onClick={async () => { if (await gen.regenerateSelected(h.id, sel)) setSel(new Set()); }}>↻ Regenerate {sel.size}</button>}
            {sel.size > 0 && <button className="btn sm danger" onClick={() => { upd((hz) => { hz.controls = hz.controls.filter((c) => !sel.has(c.id)); }); setSel(new Set()); }}>Delete {sel.size}</button>}
          </>}
          <button className="btn sm" title="Copy controls" disabled={!h.controls.length} onClick={copy}>⧉ Copy</button>
          {!ed.locked && <button className="btn sm" title="Add controls from pasted text" onClick={() => setPaste(true)}>⎘ Paste</button>}
          <button className="btn sm" title="Save as approved reference" disabled={!h.controls.length} onClick={toKb}>📚 To library</button>
          {!ed.locked && <button className="btn sm danger" title="Remove hazard" onClick={removeHazard}>×</button>}
        </div>
      </div>
      {job?.message && job.status === 'error' && <div className="banner error" style={{ margin: '0 16px 8px' }}>{job.message}</div>}
      {gaps.length > 0 && <div className="jsa-gaps">Not yet covered: {gaps.map((g) => <span key={g} className="chip static">{g}</span>)}</div>}

      <div className="jsa-ctrls">
        {h.controls.length > 0 && !ed.locked && (
          <label className="jsa-check muted" style={{ padding: '0 16px 6px' }}>
            <input type="checkbox" checked={selectAll} onChange={(e) => setSel(e.target.checked ? new Set(h.controls.map((c) => c.id)) : new Set())} /> Select all
          </label>
        )}
        {h.controls.map((c, i) => (
          <ControlRow key={c.id} ed={ed} c={c} n={i + 1} hid={h.id} a={a} h={h} selected={sel.has(c.id)}
            onSelect={(on) => setSel((s) => { const n = new Set(s); if (on) n.add(c.id); else n.delete(c.id); return n; })} />
        ))}
        <div className="jsa-drop-end" onDragOver={(e) => { if (dragging?.kind === 'control') e.preventDefault(); }}
          onDrop={(e) => { if (dragging?.kind === 'control') { e.preventDefault(); moveControl(ed, dragging, h.id, h.controls.length); dragging = null; } }}>
          {h.controls.length === 0 && <span className="muted">No control measures yet — generate them with AI or add them manually.</span>}
        </div>
        {!ed.locked && <div style={{ padding: '4px 16px 0' }}><button className="btn sm" onClick={() => upd((hz) => { hz.controls.push(newControl('')); })}>＋ Add control</button></div>}
      </div>
      {paste && <PasteControls onClose={() => setPaste(false)} existing={h.controls.map((c) => c.text)}
        onAdd={(texts) => { upd((hz) => { texts.forEach((t) => hz.controls.push(newControl(t))); }); setPaste(false); toast(`${texts.length} controls added`); }} />}
    </div>
  );
}

const ControlRow = memo(function ControlRow({ ed, c, n, hid, a, h, selected, onSelect }: {
  ed: JsaEditor; c: JControl; n: number; hid: string; a: JActivity; h: JHazard; selected: boolean; onSelect: (on: boolean) => void;
}) {
  const { toast, confirmDialog } = useApp();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (fn: (x: JControl) => void, key?: string) => ed.update((d) => {
    const hz = d.activities.flatMap((x) => x.hazards).find((x) => x.id === hid); const ct = hz?.controls.find((x) => x.id === c.id); if (ct) fn(ct);
  }, key);
  async function refine(action: 'shorten' | 'expand') {
    if (!c.text.trim()) return;
    setBusy(true);
    try {
      const doc = ed.getDoc()!; const p = paramsFor(doc, a, h);
      const text = await refineControl({ text: c.text, action, activity: a.title, hazardName: hazardName(h), job: p.job, instructions: doc.header.ai_instructions });
      set((x) => { x.text = text; x.edited = true; });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (c.edited && c.text.trim().length > 20 && !(await confirmDialog({ title: 'Delete this control?', message: 'You edited this control. Delete it? (You can undo.)', confirmLabel: 'Delete', danger: true }))) return;
    ed.update((d) => { const hz = d.activities.flatMap((x) => x.hazards).find((x) => x.id === hid); if (hz) hz.controls = hz.controls.filter((x) => x.id !== c.id); });
  }
  const origin = c.edited ? 'Edited by you' : c.origin === 'ai' ? 'AI-generated' : c.origin === 'kb' ? 'From library' : c.origin === 'template' ? 'From template' : 'Written by you';
  return (
    <div className={`jsa-ctrl${over ? ' over' : ''}${selected ? ' sel' : ''}`}
      onDragOver={(e) => { if (dragging?.kind === 'control') { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); if (dragging?.kind === 'control') { e.preventDefault(); e.stopPropagation(); const i = ed.getDoc()!.activities.flatMap((x) => x.hazards).find((x) => x.id === hid)!.controls.findIndex((x) => x.id === c.id); moveControl(ed, dragging, hid, i); dragging = null; } }}>
      {!ed.locked && <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select control ${n}`} />}
      {!ed.locked && <span className="jsa-handle" draggable title="Drag to reorder"
        onDragStart={(e) => { dragging = { kind: 'control', hid, cid: c.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); }}
        onDragEnd={() => { dragging = null; }}>⠿</span>}
      <span className="jsa-n">{n}.</span>
      <AutoTextarea className="textarea jsa-ctrl-text" disabled={ed.locked || busy} value={c.text} placeholder="Control measure"
        onChange={(v) => set((x) => { x.text = v; if (x.origin !== 'manual') x.edited = true; }, `c-${c.id}`)} />
      <span className={`jsa-dot ${c.edited ? 'edited' : c.origin}`} title={origin} />
      {!ed.locked && <span className="jsa-row-actions">
        <button className="btn sm" title="Shorten (AI)" disabled={busy || !c.text} onClick={() => refine('shorten')}>−</button>
        <button className="btn sm" title="Expand with more detail (AI)" disabled={busy || !c.text} onClick={() => refine('expand')}>＋</button>
        <button className="btn sm" title="Duplicate" onClick={() => ed.update((d) => { const hz = d.activities.flatMap((x) => x.hazards).find((x) => x.id === hid); if (!hz) return; const i = hz.controls.findIndex((x) => x.id === c.id); hz.controls.splice(i + 1, 0, { ...c, id: uid(), origin: 'manual', edited: false }); })}>⧉</button>
        <button className="btn sm danger" title="Delete" onClick={remove}>×</button>
      </span>}
    </div>
  );
});

function PasteControls({ onAdd, onClose, existing }: { onAdd: (t: string[]) => void; onClose: () => void; existing: string[] }) {
  const [text, setText] = useState('');
  const items = splitItems(text).filter((t) => !isDuplicate(t, existing));
  return (
    <Modal title="Add controls from pasted text" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!items.length} onClick={() => onAdd(items)}>Add {items.length} controls</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Paste a numbered or bulleted list, one control per line. Numbering is removed and duplicates of existing controls are skipped.</p>
      <textarea className="textarea" style={{ minHeight: 200 }} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}
