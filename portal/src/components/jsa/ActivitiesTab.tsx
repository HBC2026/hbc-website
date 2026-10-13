'use client';
import { useState } from 'react';
import { useApp } from '@/components/Providers';
import { Modal } from '@/components/ui';
import { structureText } from '@/lib/jsa/client';
import { parseActivities } from '@/lib/jsa/parse';
import { matchCategory } from '@/lib/jsa/parse';
import type { JsaEditor } from '@/lib/jsa/useJsaDoc';
import { uid, type JActivity, type JsaSettings } from '@/lib/jsa/types';
import { ActivityRows } from './ActivityRows';

export function ActivitiesTab({ ed, settings }: { ed: JsaEditor; settings: JsaSettings }) {
  const doc = ed.doc!;
  const [paste, setPaste] = useState(false);
  return (
    <div className="stack">
      {ed.locked && <div className="banner">This JSA is finalized. Create a new revision (History tab) to change it.</div>}
      <div className="panel flush">
        <div className="panel-head">
          <div>
            <div className="panel-title">Work activities &amp; hazards</div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Add as many activities as the job needs. Each activity can have several hazards. Hazard categories are managed in JSA Settings.</div>
          </div>
          {!ed.locked && <button className="btn" onClick={() => setPaste(true)}>⎘ Paste table or list</button>}
        </div>
        <ActivityRows activities={doc.activities} categories={settings.hazard_categories} disabled={ed.locked}
          onChange={(next, key) => ed.update((d) => { d.activities = next as typeof d.activities; }, key)} />
      </div>
      {paste && <PasteModal categories={settings.hazard_categories} hasExisting={doc.activities.length > 0}
        onClose={() => setPaste(false)}
        onApply={(acts, replace) => { ed.update((d) => { d.activities = (replace ? acts : [...d.activities, ...acts]) as typeof d.activities; }); setPaste(false); }} />}
    </div>
  );
}

function PasteModal({ categories, hasExisting, onClose, onApply }: {
  categories: string[]; hasExisting: boolean; onClose: () => void; onApply: (a: JActivity[], replace: boolean) => void;
}) {
  const { toast, confirmDialog } = useApp();
  const [text, setText] = useState('');
  const [acts, setActs] = useState<JActivity[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function analyse() {
    const r = parseActivities(text, categories);
    setActs(r.activities); setWarnings(r.warnings);
    if (!r.activities.length) toast('No work activities were recognised. Try the AI option or check the pasted text.', true);
  }
  async function analyseAi() {
    setBusy(true);
    try {
      const out = await structureText(text, categories);
      setActs(out.map((a) => ({
        id: uid(), title: a.title, equipment: a.equipment ?? '', instructions: '',
        hazards: a.hazards.map((h) => {
          const m = matchCategory(h.name, categories);
          return { id: uid(), category: m.category, custom_name: m.custom, instructions: '', controls: h.controls.map((c) => ({ id: uid(), text: c, origin: 'manual' as const, edited: false })) };
        }),
      })));
      setWarnings(['Recognised with AI — check every activity and hazard before continuing.']);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }
  async function apply(replace: boolean) {
    if (!acts?.length) return;
    if (replace && !(await confirmDialog({ title: 'Replace all activities?', message: 'The current activities, hazards and control measures will be replaced. You can undo this with Ctrl+Z.', confirmLabel: 'Replace', danger: true }))) return;
    onApply(acts, replace);
  }
  const controls = acts?.reduce((n, a) => n + a.hazards.reduce((m, h) => m + h.controls.length, 0), 0) ?? 0;

  return (
    <Modal wide title="Paste work activities and hazards" onClose={onClose} footer={acts ? (
      <>
        <button className="btn" onClick={() => setActs(null)}>← Back</button>
        {hasExisting && <button className="btn danger" disabled={!acts.length} onClick={() => apply(true)}>Replace existing</button>}
        <button className="btn primary" disabled={!acts.length} onClick={() => apply(false)}>{hasExisting ? 'Add to JSA' : 'Use these activities'}</button>
      </>
    ) : (
      <>
        <button className="btn" disabled={busy || text.trim().length < 20} onClick={analyseAi} title="Let the AI structure free-form text">{busy ? 'Reading…' : '✦ Recognise with AI'}</button>
        <button className="btn primary" disabled={!text.trim()} onClick={analyse}>Recognise table</button>
      </>
    )}>
      {!acts ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Paste a table copied from Word, Excel or ChatGPT (columns such as No. / Work Activity / Risk-Hazard / Control Measures), a markdown table, or a simple list. You can correct everything before it is added.</p>
          <textarea className="textarea" style={{ minHeight: 260, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'No.\tWork Activity\tRisk / Hazard\n1\tConcrete cutting\tNoise; Electricity\n2\tScaffold erection\tWorking at Height / Scaffold'} />
        </>
      ) : (
        <>
          {warnings.map((w, i) => <div key={i} className="banner warn" style={{ marginBottom: 8 }}>{w}</div>)}
          <div className="muted" style={{ marginBottom: 8 }}>{acts.length} activities · {acts.reduce((n, a) => n + a.hazards.length, 0)} hazards{controls ? ` · ${controls} pasted control measures kept` : ''}. Correct anything below.</div>
          <ActivityRows activities={acts} categories={categories} onChange={(n) => setActs(n)} />
        </>
      )}
    </Modal>
  );
}
