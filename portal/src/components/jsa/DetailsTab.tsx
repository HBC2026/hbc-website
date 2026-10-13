'use client';
import { DatePicker, Field, SuggestInput } from '@/components/ui';
import type { JsaEditor } from '@/lib/jsa/useJsaDoc';
import type { JsaHeader } from '@/lib/jsa/types';
import { AutoTextarea } from './common';

export function DetailsTab({ ed, projects }: { ed: JsaEditor; projects: string[] }) {
  const h = ed.doc!.header;
  const dis = ed.locked;
  const set = (k: keyof JsaHeader, v: string) => ed.update((d) => { (d.header as unknown as Record<string, unknown>)[k] = v; }, `h-${k}`);
  return (
    <div className="panel">
      <div className="panel-title">JSA details</div>
      {dis && <div className="banner">This JSA is finalized and read-only. Create a new revision to change it.</div>}
      <div className="form-grid">
        <Field label="JSA Number (generated automatically, editable)"><input className="input mono" disabled={dis} value={h.number} onChange={(e) => set('number', e.target.value)} /></Field>
        <Field label="Project Name"><SuggestInput value={h.project} options={projects} onChange={(v) => set('project', v)} /></Field>
        <Field label="Client Name"><input className="input" disabled={dis} value={h.client} onChange={(e) => set('client', e.target.value)} /></Field>
        <Field label="Work Location"><input className="input" disabled={dis} value={h.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Mill 2, Bay 4" /></Field>
        <Field label="Date"><DatePicker value={h.jsa_date} disabled={dis} onChange={(v) => set('jsa_date', v)} /></Field>
        <Field label="Prepared By"><input className="input" disabled={dis} value={h.prepared_by} onChange={(e) => set('prepared_by', e.target.value)} /></Field>
        <Field className="span-3" label="Work Description"><AutoTextarea minRows={3} disabled={dis} value={h.work_description} onChange={(v) => set('work_description', v)} placeholder="Describe the job: what, where and how the work will be carried out" /></Field>
        <Field className="span-3" label="Equipment / Tools Involved"><AutoTextarea minRows={2} disabled={dis} value={h.equipment} onChange={(v) => set('equipment', v)} placeholder="e.g. Concrete saw, angle grinder with 230 mm disc, jackhammer, compressor, scaffold tower" /></Field>
        <Field className="span-3" label="Additional Safety Instructions"><AutoTextarea minRows={3} disabled={dis} value={h.additional_instructions} onChange={(v) => set('additional_instructions', v)} placeholder="Job-specific requirements from the client or permit, to be reflected in the controls" /></Field>
      </div>
    </div>
  );
}
