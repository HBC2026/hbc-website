'use client';
import { useApp } from '@/components/Providers';
import { Select } from '@/components/ui';
import { AutoTextarea } from './common';
import { newActivity, newHazard, uid, OTHER_HAZARD, type JActivity, type JHazard } from '@/lib/jsa/types';

/** Editable table of work activities and their hazards (controls are untouched here). Used by the Activities tab and the paste preview. */
export function ActivityRows({ activities, categories, onChange, disabled }: {
  activities: JActivity[]; categories: string[]; disabled?: boolean;
  onChange: (next: JActivity[], coalesceKey?: string) => void;
}) {
  const { confirmDialog } = useApp();
  const setAct = (id: string, patch: Partial<JActivity>, key?: string) =>
    onChange(activities.map((a) => (a.id === id ? { ...a, ...patch } : a)), key);
  const setHaz = (aid: string, hid: string, patch: Partial<JHazard>, key?: string) =>
    setAct(aid, { hazards: activities.find((a) => a.id === aid)!.hazards.map((h) => (h.id === hid ? { ...h, ...patch } : h)) }, key);

  async function removeActivity(a: JActivity) {
    const n = a.hazards.reduce((s, h) => s + h.controls.length, 0);
    if (n > 0 && !(await confirmDialog({ title: 'Delete activity?', message: `“${a.title || 'Untitled activity'}” has ${n} control measure${n === 1 ? '' : 's'}. They will be removed with it (you can undo with Ctrl+Z).`, confirmLabel: 'Delete', danger: true }))) return;
    onChange(activities.filter((x) => x.id !== a.id));
  }
  async function removeHazard(a: JActivity, h: JHazard) {
    if (h.controls.length > 0 && !(await confirmDialog({ title: 'Remove hazard?', message: `This hazard has ${h.controls.length} control measure${h.controls.length === 1 ? '' : 's'} that will be removed with it.`, confirmLabel: 'Remove', danger: true }))) return;
    setAct(a.id, { hazards: a.hazards.filter((x) => x.id !== h.id) });
  }
  const duplicate = (a: JActivity) => {
    const copy: JActivity = { ...a, id: uid(), title: a.title ? `${a.title} (copy)` : '', hazards: a.hazards.map((h) => ({ ...h, id: uid(), controls: h.controls.map((c) => ({ ...c, id: uid() })) })) };
    onChange(activities.flatMap((x) => (x.id === a.id ? [x, copy] : [x])));
  };
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= activities.length) return;
    const next = activities.slice(); [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  };
  const options = (current: string) => (categories.includes(current) ? categories : [...categories, current]);

  return (
    <div className="table-wrap"><table className="table jsa-acts">
      <thead><tr><th style={{ width: 44 }}>No.</th><th style={{ width: '34%' }}>Work Activity</th><th>Risk / Hazard</th><th style={{ width: 70 }}>Controls</th><th style={{ width: 150 }} /></tr></thead>
      <tbody>
        {activities.map((a, i) => (
          <tr key={a.id}>
            <td className="strong">{i + 1}</td>
            <td>
              <AutoTextarea value={a.title} disabled={disabled} placeholder="Work activity" onChange={(v) => setAct(a.id, { title: v }, `t-${a.id}`)} />
              <input className="input" style={{ marginTop: 6 }} disabled={disabled} placeholder="Equipment / tools for this activity" value={a.equipment}
                onChange={(e) => setAct(a.id, { equipment: e.target.value }, `e-${a.id}`)} />
            </td>
            <td>
              <div className="jsa-haz-list">
                {a.hazards.map((h) => (
                  <div key={h.id} className="jsa-haz-row">
                    <Select className="select" value={h.category} disabled={disabled} onChange={(e) => setHaz(a.id, h.id, { category: e.target.value })}>
                      {options(h.category).map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                    <input className="input" disabled={disabled} placeholder={h.category === OTHER_HAZARD ? 'Describe the hazard' : 'Specific wording (optional)'} value={h.custom_name}
                      onChange={(e) => setHaz(a.id, h.id, { custom_name: e.target.value }, `h-${h.id}`)} />
                    <span className="muted jsa-haz-n" title="Control measures">{h.controls.length}</span>
                    {!disabled && <button className="btn sm danger" title="Remove hazard" onClick={() => removeHazard(a, h)}>×</button>}
                  </div>
                ))}
                {!disabled && <button className="btn sm" onClick={() => setAct(a.id, { hazards: [...a.hazards, newHazard()] })}>＋ Hazard</button>}
              </div>
            </td>
            <td className="muted">{a.hazards.reduce((n, h) => n + h.controls.length, 0)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {!disabled && <>
                <button className="btn sm" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>{' '}
                <button className="btn sm" title="Move down" disabled={i === activities.length - 1} onClick={() => move(i, 1)}>↓</button>{' '}
                <button className="btn sm" title="Duplicate activity" onClick={() => duplicate(a)}>⧉</button>{' '}
                <button className="btn sm danger" title="Delete activity" onClick={() => removeActivity(a)}>🗑</button>
              </>}
            </td>
          </tr>
        ))}
        {activities.length === 0 && <tr><td colSpan={5}><div className="empty">No work activities yet.</div></td></tr>}
        {!disabled && <tr><td colSpan={5}><button className="btn sm" onClick={() => onChange([...activities, newActivity()])}>＋ Add work activity</button></td></tr>}
      </tbody>
    </table></div>
  );
}
