'use client';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Select } from '@/components/ui';
import type { GenMode } from '@/lib/jsa/merge';
import { hazardName, type JsaSettings } from '@/lib/jsa/types';
import type { Generator } from '@/lib/jsa/useGenerator';
import type { JsaEditor } from '@/lib/jsa/useJsaDoc';
import { AutoTextarea, ReviewNotice } from './common';

const EXAMPLES = [
  'Use grinder and jackhammer. Include anti-vibration gloves and concrete dust control.',
  'Include 20 detailed fire safety measures for welding.',
  'Scaffold platform is below 1.8 m. Apply the relevant site scaffold and fall-protection rules.',
];
const MODES: [GenMode, string, string][] = [
  ['fill', 'Fill up to the target', 'Keeps every existing control and adds only what is missing.'],
  ['replace_ai', 'Regenerate untouched AI controls', 'Replaces AI controls you have not edited. Your own and edited controls are kept.'],
  ['add_more', 'Add more controls', 'Keeps everything and adds the number below as extra controls.'],
  ['replace_all', 'Replace everything (asks first)', 'Replaces all controls, including ones you edited — after confirmation.'],
];

export function GeneratorTab({ ed, gen, settings }: { ed: JsaEditor; gen: Generator; settings: JsaSettings }) {
  const doc = ed.doc!;
  const all = useMemo(() => doc.activities.flatMap((a) => a.hazards.map((h) => ({ a, h }))), [doc.activities]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(all.filter(({ h }) => !h.controls.length).map(({ h }) => h.id)));
  const [count, setCount] = useState(settings.default_control_count);
  const [mode, setMode] = useState<GenMode>('fill');
  useEffect(() => setCount(settings.default_control_count), [settings.default_control_count]);

  const toggle = (ids: string[], on: boolean) => setSel((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });
  const picked = all.filter(({ h }) => sel.has(h.id));
  const totalControls = all.reduce((n, { h }) => n + h.controls.length, 0);
  const instr = doc.header.ai_instructions;

  if (!all.length) return <div className="panel"><div className="empty">Add work activities and hazards first (Activities &amp; Hazards tab), then come back to generate controls.</div></div>;

  return (
    <div className="jsa-gen">
      <div className="stack">
        {!gen.ai.configured && gen.ai.checked && (
          <div className="banner error"><strong>AI is not available.</strong> {gen.ai.error ?? 'No API key is configured on the server. Add JSA_AI_API_KEY (and optionally JSA_AI_PROVIDER, JSA_AI_MODEL) to the server environment and redeploy. You can still write controls by hand in the Editor tab.'}</div>
        )}
        {gen.ai.configured && <div className="muted" style={{ fontSize: 11 }}>AI: {gen.ai.provider} · {gen.ai.model}. Each hazard is generated separately using your approved Safety Knowledge Base entries and rules.</div>}
        <ReviewNotice />

        <div className="panel flush">
          <div className="panel-head">
            <div className="panel-title">1 · Choose activities and hazards</div>
            <div className="toolbar">
              <button className="btn sm" onClick={() => toggle(all.map((x) => x.h.id), true)}>All</button>
              <button className="btn sm" onClick={() => toggle(all.map((x) => x.h.id), false)}>None</button>
              <button className="btn sm" onClick={() => setSel(new Set(all.filter((x) => !x.h.controls.length).map((x) => x.h.id)))}>Without controls</button>
            </div>
          </div>
          <div className="jsa-tree">
            {doc.activities.map((a, i) => {
              const ids = a.hazards.map((h) => h.id);
              const on = ids.length > 0 && ids.every((id) => sel.has(id));
              return (
                <div key={a.id} className="jsa-tree-act">
                  <label className="jsa-check strong"><input type="checkbox" checked={on} disabled={!ids.length} onChange={(e) => toggle(ids, e.target.checked)} /> {i + 1}. {a.title || <em className="muted">Untitled activity</em>}</label>
                  <input className="input" style={{ margin: '6px 0 4px 22px', width: 'calc(100% - 22px)' }} placeholder="Notes for the AI about this activity (optional)" disabled={ed.locked}
                    value={a.instructions} onChange={(e) => ed.update((d) => { d.activities[i].instructions = e.target.value; }, `ai-a-${a.id}`)} />
                  {a.hazards.map((h, hi) => {
                    const j = gen.jobs[h.id];
                    return (
                      <div key={h.id} className="jsa-tree-haz">
                        <label className="jsa-check"><input type="checkbox" checked={sel.has(h.id)} onChange={(e) => toggle([h.id], e.target.checked)} /> {hazardName(h)}</label>
                        <span className="muted">{h.controls.length} controls</span>
                        {j && <JobBadge status={j.status} added={j.added} />}
                        <input className="input" style={{ gridColumn: '1 / -1', marginLeft: 22, width: 'calc(100% - 22px)' }} placeholder="Notes for the AI about this hazard (optional)" disabled={ed.locked}
                          value={h.instructions} onChange={(e) => ed.update((d) => { d.activities[i].hazards[hi].instructions = e.target.value; }, `ai-h-${h.id}`)} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="panel">
          <div className="panel-title">2 · Settings</div>
          <Field2 label="Controls per hazard">
            <div className="toolbar">
              {[[16, '16'], [20, '20'], [25, '25'], [32, '32 complex'], [40, '40 complex']].map(([n, l]) => (
                <button key={n} className={`btn sm${count === n ? ' primary' : ''}`} onClick={() => setCount(n as number)}>{l}</button>
              ))}
              <input className="input num" style={{ width: 70 }} type="number" min={3} max={80} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Custom number of controls" />
            </div>
          </Field2>
          <Field2 label="If a hazard already has controls">
            <Select className="select" value={mode} onChange={(e) => setMode(e.target.value as GenMode)}>
              {MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
            <div className="muted" style={{ fontSize: 11 }}>{MODES.find((m) => m[0] === mode)![2]}</div>
          </Field2>
          <Field2 label="Additional instructions for the AI (saved with this JSA)">
            <AutoTextarea minRows={3} disabled={ed.locked} value={instr} placeholder="e.g. Use grinder and jackhammer. Include anti-vibration gloves and concrete dust control."
              onChange={(v) => ed.update((d) => { d.header.ai_instructions = v; }, 'ai-instr')} />
            <div className="jsa-chips">
              {EXAMPLES.map((x) => <button key={x} className="chip" disabled={ed.locked} onClick={() => ed.update((d) => { d.header.ai_instructions = d.header.ai_instructions ? `${d.header.ai_instructions}\n${x}` : x; })}>＋ {x.slice(0, 44)}…</button>)}
            </div>
            <div className="muted" style={{ fontSize: 10.5 }}>Instructions steer scope and emphasis. They cannot remove critical safety precautions; conflicts are flagged below.</div>
          </Field2>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={gen.running || !picked.length || ed.locked || !gen.ai.configured}
              onClick={() => gen.run(picked.map((x) => x.h.id), { mode, count })}>
              {gen.running ? 'Generating…' : `✦ Generate for ${picked.length} hazard${picked.length === 1 ? '' : 's'}`}
            </button>
            {gen.running && <button className="btn danger" onClick={gen.cancel}>Cancel</button>}
            <span className="muted">{totalControls} controls in the JSA</span>
          </div>
        </div>

        <Progress gen={gen} onRetry={(id) => gen.run([id], { mode: 'fill', count })} />
      </div>
    </div>
  );
}

const Field2 = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="field" style={{ marginBottom: 14 }}><label>{label}</label>{children}</div>
);

function JobBadge({ status, added }: { status: string; added: number }) {
  const tone = status === 'done' ? 'green' : status === 'error' ? 'red' : status === 'running' ? 'blue' : '';
  const label = status === 'done' ? `+${added}` : status === 'running' ? 'Generating…' : status === 'queued' ? 'Queued' : status === 'skipped' ? 'Skipped' : status === 'cancelled' ? 'Cancelled' : 'Failed';
  return <Badge tone={tone}>{label}</Badge>;
}

function Progress({ gen, onRetry }: { gen: Generator; onRetry: (id: string) => void }) {
  const list = Object.values(gen.jobs);
  if (!list.length) return null;
  const done = list.filter((j) => ['done', 'skipped', 'error', 'cancelled'].includes(j.status)).length;
  const flags = Array.from(new Set(list.flatMap((j) => j.flags)));
  const gaps = list.filter((j) => j.gaps.length);
  return (
    <div className="panel">
      <div className="panel-title">3 · Progress</div>
      <div className="jsa-bar"><div style={{ width: `${(done / list.length) * 100}%` }} /></div>
      <div className="muted" style={{ margin: '6px 0 10px' }}>{done} of {list.length} hazards finished</div>
      {list.map((j) => (
        <div key={j.hazardId} className="jsa-job">
          <span className="jsa-clip">{j.label}</span>
          <JobBadge status={j.status} added={j.added} />
          {j.references > 0 && <span className="muted" title="Approved Knowledge Base entries used as references">📚 {j.references}</span>}
          {j.status === 'error' && <button className="btn sm" onClick={() => onRetry(j.hazardId)}>Retry</button>}
          {j.message && <div className="jsa-job-msg">{j.message}</div>}
        </div>
      ))}
      {flags.length > 0 && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <strong>For your review (uncertainty or conflicts flagged by the AI):</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>{flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
      {gaps.length > 0 && (
        <div className="banner" style={{ marginTop: 12 }}>
          <strong>Mandatory topics not found in the generated controls:</strong>
          <ul style={{ margin: '6px 0 0 18px' }}>{gaps.map((j) => <li key={j.hazardId}>{j.label}: {j.gaps.join(', ')}</li>)}</ul>
          <div className="muted" style={{ marginTop: 4 }}>Add them in the Editor or regenerate with an additional instruction.</div>
        </div>
      )}
    </div>
  );
}
