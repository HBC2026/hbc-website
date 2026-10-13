'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActivityRows } from '@/components/jsa/ActivityRows';
import { AutoTextarea, JsaGuard } from '@/components/jsa/common';
import { useApp } from '@/components/Providers';
import { ErrorBox, Field, Loading, Modal, PageHead } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { createJsa } from '@/lib/jsa/client';
import { starterTemplates } from '@/lib/jsa/starterTemplates';
import { uid, type JActivity, type JsaTemplate } from '@/lib/jsa/types';
import { useJsaSettings } from '@/lib/jsa/useSettings';
import { supabase, unwrap } from '@/lib/supabase';

export default function TemplatesPage() {
  return <JsaGuard><Inner /></JsaGuard>;
}

interface Draft { id?: string; name: string; description: string; activities: JActivity[] }
const reId = (acts: JActivity[]): JActivity[] => acts.map((a) => ({ ...a, id: uid(), hazards: a.hazards.map((h) => ({ ...h, id: uid(), controls: h.controls.map((c) => ({ ...c, id: uid() })) })) }));

function Inner() {
  const { toast, confirmDialog } = useApp();
  const router = useRouter();
  const sb = supabase();
  const { settings } = useJsaSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('jsa_templates').select('id, name, description, content, updated_at, deleted_at').is('deleted_at', null).order('name')) as JsaTemplate[], []);

  async function loadStarters() {
    const have = new Set((data ?? []).map((t) => t.name.toLowerCase()));
    const add = starterTemplates().filter((t) => !have.has(t.name.toLowerCase()));
    if (!add.length) return toast('All starter templates are already loaded');
    const { error } = await sb.from('jsa_templates').insert(add);
    if (error) return toast(error.message, true);
    toast(`${add.length} starter templates added`); reload();
  }
  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return toast('Template name is required', true);
    const row = { name: draft.name.trim(), description: draft.description.trim(), content: { activities: draft.activities } };
    const res = draft.id ? await sb.from('jsa_templates').update(row).eq('id', draft.id) : await sb.from('jsa_templates').insert([row]);
    if (res.error) return toast(res.error.message, true);
    toast('Template saved'); setDraft(null); reload();
  }
  async function duplicate(t: JsaTemplate) {
    const { error } = await sb.from('jsa_templates').insert([{ name: `${t.name} (copy)`, description: t.description, content: { activities: reId(t.content.activities) } }]);
    if (error) return toast(error.message, true);
    toast('Template duplicated'); reload();
  }
  async function remove(t: JsaTemplate) {
    if (!(await confirmDialog({ title: 'Delete template?', message: `“${t.name}” will be deleted. JSAs already created from it are not affected.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.from('jsa_templates').update({ deleted_at: new Date().toISOString() }).eq('id', t.id);
    if (error) return toast(error.message, true);
    toast('Template deleted'); reload();
  }
  async function use(t: JsaTemplate) {
    if (!(await confirmDialog({ title: 'Review before use', message: `“${t.name}” is a reusable starting point. Its activities, hazards and controls must be reviewed for suitability for the specific job before the JSA is finalized.`, confirmLabel: 'Create JSA' }))) return;
    setBusy(true);
    try { router.push(`/adminconsole/jsa/${await createJsa({}, t.content.activities)}?tab=activities`); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), true); setBusy(false); }
  }

  return (
    <>
      <PageHead eyebrow="JSA Management" title="JSA Templates" sub="Reusable starting points: activities, hazards and (where you saved them) reviewed controls">
        <button className="btn" onClick={loadStarters}>Load starter templates</button>
        <button className="btn primary" onClick={() => setDraft({ name: '', description: '', activities: [] })}>＋ New template</button>
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="banner warn">Templates must be reviewed for suitability before use on a new job. The starter templates contain activities and typical hazards only — no control measures are pre-approved.</div>
      <div className="panel flush">
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Template</th><th>Description</th><th>Activities</th><th>Hazards</th><th>Controls</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map((t) => {
                const hz = t.content.activities.flatMap((a) => a.hazards);
                return (
                  <tr key={t.id}>
                    <td className="strong">{t.name}</td><td className="jsa-desc">{t.description}</td>
                    <td>{t.content.activities.length}</td><td>{hz.length}</td><td>{hz.reduce((n, h) => n + h.controls.length, 0)}</td><td>{fmtDateTime(t.updated_at)}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button className="btn sm primary" disabled={busy} onClick={() => use(t)}>Use</button>{' '}
                      <button className="btn sm" onClick={() => setDraft({ id: t.id, name: t.name, description: t.description, activities: t.content.activities })}>Edit</button>{' '}
                      <button className="btn sm" onClick={() => duplicate(t)}>Duplicate</button>{' '}
                      <button className="btn sm danger" onClick={() => remove(t)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              {(data ?? []).length === 0 && <tr><td colSpan={7}><div className="empty">No templates yet. Click “Load starter templates” for Concrete Cutting, Welding, Scaffolding and more, or create your own.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      {draft && (
        <Modal wide title={draft.id ? 'Edit template' : 'New template'} onClose={() => setDraft(null)} footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" onClick={save}>Save template</button></>}>
          <div className="form-grid">
            <Field className="span-3" label="Name"><input className="input" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field className="span-3" label="Description"><AutoTextarea minRows={2} value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} /></Field>
          </div>
          <div className="label" style={{ margin: '16px 0 6px' }}>Activities &amp; hazards</div>
          <ActivityRows activities={draft.activities} categories={settings.hazard_categories} onChange={(a) => setDraft({ ...draft, activities: a })} />
          <p className="muted" style={{ marginBottom: 0 }}>Control measures already in a template are kept. To change them, create a JSA from the template, edit it, and use “Save as template” on the Finalize &amp; History tab.</p>
        </Modal>
      )}
    </>
  );
}
