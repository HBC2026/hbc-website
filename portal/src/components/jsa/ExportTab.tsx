'use client';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Field, Loading, Modal, Select } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { buildExport, type ExportModel } from '@/lib/jsa/exportModel';
import { downloadPdf, downloadWord, logoUrl } from '@/lib/jsa/exportFiles';
import { REVIEW_NOTICE, type ExportTemplate, type JsaRevision, type JsaSettings } from '@/lib/jsa/types';
import type { JsaEditor } from '@/lib/jsa/useJsaDoc';
import { supabase, unwrap } from '@/lib/supabase';
import { JsaStatusBadge } from './common';

function useCompany() {
  const { settings } = useApp();
  return { name: settings.company.name, logo: logoUrl(settings.company.logo), address: settings.company.address };
}

function useExporter() {
  const { toast } = useApp();
  const [busy, setBusy] = useState<'word' | 'pdf' | null>(null);
  async function run(kind: 'word' | 'pdf', m: ExportModel) {
    setBusy(kind);
    try { await (kind === 'word' ? downloadWord(m) : downloadPdf(m)); }
    catch (e) { toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, true); }
    finally { setBusy(null); }
  }
  return { busy, run };
}

export function ExportTab({ ed, settings }: { ed: JsaEditor; settings: JsaSettings }) {
  const doc = ed.doc!;
  const company = useCompany();
  const { busy, run } = useExporter();
  const [tplId, setTplId] = useState(settings.export_templates[0]?.id ?? '');
  const [orient, setOrient] = useState<'' | 'portrait' | 'landscape'>('');
  const tpl: ExportTemplate = settings.export_templates.find((t) => t.id === tplId) ?? settings.export_templates[0];
  const model = useMemo(() => buildExport({ header: doc.header, activities: doc.activities, company, template: tpl, finalizedAt: doc.finalized_at, orientation: orient || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.header, doc.activities, tpl, orient, doc.finalized_at]);
  const empty = doc.activities.every((a) => a.hazards.every((h) => !h.controls.length));
  const missing = doc.activities.flatMap((a) => a.hazards.filter((h) => !h.controls.length).map((h) => `${a.title || 'Untitled'} — ${h.category}`));
  const qs = `tpl=${encodeURIComponent(tpl.id)}${orient ? `&o=${orient}` : ''}`;

  return (
    <div className="stack">
      {model.draft && <div className="banner warn"><strong>This JSA is a Draft.</strong> Every export is marked DRAFT (watermark / header) and must not be used on site until it has been reviewed and finalized.</div>}
      {missing.length > 0 && <div className="banner warn">{missing.length} hazard{missing.length === 1 ? ' has' : 's have'} no control measures yet: {missing.slice(0, 4).join('; ')}{missing.length > 4 ? '…' : ''}</div>}
      <div className="panel">
        <div className="panel-title">Export</div>
        <div className="form-grid">
          <Field label="Document template">
            <Select className="select" value={tpl.id} onChange={(e) => setTplId(e.target.value)}>
              {settings.export_templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Page orientation">
            <Select className="select" value={orient} onChange={(e) => setOrient(e.target.value as typeof orient)}>
              <option value="">Template default ({tpl.orientation})</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option>
            </Select>
          </Field>
          <Field label="Signature boxes"><div className="muted" style={{ paddingTop: 9 }}>{tpl.signatures.length ? tpl.signatures.join(' · ') : 'None'} <span style={{ fontSize: 10 }}>(left blank — nothing is signed for you)</span></div></Field>
        </div>
        <div className="toolbar" style={{ marginTop: 18 }}>
          <button className="btn" onClick={async () => { if (await ed.save()) window.open(`/adminconsole/jsa/${doc.id}/print?${qs}`, '_blank'); }}>🖨 Print preview</button>
          <button className="btn primary" disabled={!!busy || empty} onClick={() => run('word', model)}>{busy === 'word' ? 'Preparing…' : '⬇ Download Word (.docx)'}</button>
          <button className="btn primary" disabled={!!busy || empty} onClick={() => run('pdf', model)}>{busy === 'pdf' ? 'Preparing…' : '⬇ Download PDF'}</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>{REVIEW_NOTICE}</p>
      </div>
    </div>
  );
}

export function HistoryTab({ ed, settings, onChanged }: { ed: JsaEditor; settings: JsaSettings; onChanged: () => void }) {
  const doc = ed.doc!;
  const { toast } = useApp();
  const company = useCompany();
  const { busy, run } = useExporter();
  const sb = supabase();
  const [finalizing, setFinalizing] = useState(false);
  const [working, setWorking] = useState(false);
  const [tplName, setTplName] = useState<string | null>(null);
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('jsa_revisions').select('id, revision, created_at, finalized_by_name, snapshot').eq('jsa_id', doc.id).order('revision', { ascending: false })) as JsaRevision[], [doc.id, doc.version]);

  async function newRevision() {
    setWorking(true);
    const { data: r, error } = await sb.rpc('jsa_new_revision', { p_id: doc.id });
    setWorking(false);
    if (error) return toast(error.message, true);
    toast(`Revision ${r} created as a Draft. The finalized version was preserved.`); await ed.reload(); reload(); onChanged();
  }
  async function saveTemplate() {
    const name = (tplName ?? '').trim();
    if (!name) return toast('Enter a template name', true);
    const acts = doc.activities.map((a) => ({ ...a, id: crypto.randomUUID(), hazards: a.hazards.map((h) => ({ ...h, id: crypto.randomUUID(), controls: h.controls.filter((c) => c.text.trim()).map((c) => ({ ...c, id: crypto.randomUUID(), origin: 'template' as const, edited: false })) })) }));
    const { error } = await sb.from('jsa_templates').insert([{ name, description: [doc.header.project, doc.header.work_description].filter(Boolean).join(' — ').slice(0, 300), content: { activities: acts } }]);
    if (error) return toast(error.message, true);
    toast('Saved as template'); setTplName(null);
  }
  const modelFor = (r: JsaRevision) => buildExport({ header: { ...r.snapshot.header, status: 'finalized' }, activities: r.snapshot.activities, company, template: settings.export_templates[0], finalizedAt: r.created_at });

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-title">Finalization</div>
        <div className="toolbar" style={{ marginBottom: 10 }}><JsaStatusBadge s={doc.header.status} revision={doc.header.revision} />
          <span className="muted">{doc.header.status === 'draft' ? 'Editable. AI generation available. Exports are marked DRAFT.' : `Finalized ${fmtDateTime(doc.finalized_at)}. Read-only; exports are official.`}</span></div>
        {doc.header.status === 'draft'
          ? <button className="btn green" onClick={async () => { if (await ed.save()) setFinalizing(true); }}>✓ Finalize JSA</button>
          : <button className="btn primary" disabled={working} onClick={newRevision}>{working ? 'Creating…' : `＋ New revision (Rev ${doc.header.revision + 1})`}</button>}
        <button className="btn" style={{ marginLeft: 8 }} onClick={() => setTplName(doc.header.work_description.slice(0, 60) || doc.header.number)}>▣ Save as template</button>
        <p className="muted" style={{ marginBottom: 0 }}>Finalization is an internal document-management action. It does not replace any approval required by TENARIS or the site permit process. Changing a finalized JSA creates a new revision that returns to Draft; every finalized version is kept unchanged below.</p>
      </div>

      <div className="panel flush">
        <div className="panel-head"><div className="panel-title">Finalized versions</div><span className="muted">{data?.length ?? 0}</span></div>
        {error && <ErrorBox error={error} />}
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Revision</th><th>Finalized</th><th>By</th><th>Activities</th><th>Controls</th><th /></tr></thead>
            <tbody>
              {(data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="strong">Rev {r.revision}</td><td>{fmtDateTime(r.created_at)}</td><td>{r.finalized_by_name || '—'}</td>
                  <td>{r.snapshot.activities.length}</td>
                  <td>{r.snapshot.activities.reduce((n, a) => n + a.hazards.reduce((m, h) => m + h.controls.length, 0), 0)}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <a className="btn sm" target="_blank" rel="noreferrer" href={`/adminconsole/jsa/${doc.id}/print?rev=${r.revision}`}>View</a>{' '}
                    <button className="btn sm" disabled={!!busy} onClick={() => run('word', modelFor(r))}>Word</button>{' '}
                    <button className="btn sm" disabled={!!busy} onClick={() => run('pdf', modelFor(r))}>PDF</button>
                  </td>
                </tr>
              ))}
              {(data ?? []).length === 0 && <tr><td colSpan={6}><div className="empty">Nothing finalized yet.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      {finalizing && <FinalizeModal ed={ed} onClose={() => setFinalizing(false)} onDone={async () => { setFinalizing(false); await ed.reload(); reload(); onChanged(); }} />}
      {tplName !== null && (
        <Modal title="Save as template" onClose={() => setTplName(null)} footer={<><button className="btn" onClick={() => setTplName(null)}>Cancel</button><button className="btn primary" onClick={saveTemplate}>Save template</button></>}>
          <Field label="Template name"><input className="input" autoFocus value={tplName} onChange={(e) => setTplName(e.target.value)} /></Field>
          <p className="muted" style={{ marginBottom: 0 }}>Activities, hazards and the current control measures are copied. Templates must be reviewed for suitability before each use.</p>
        </Modal>
      )}
    </div>
  );
}

export function FinalizeModal({ ed, onClose, onDone }: { ed: JsaEditor; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const doc = ed.doc!;
  const hazards = doc.activities.flatMap((a) => a.hazards);
  const missing = hazards.filter((h) => !h.controls.length).length;
  const blank = hazards.reduce((n, h) => n + h.controls.filter((c) => !c.text.trim()).length, 0);
  async function go() {
    setBusy(true);
    const v = ed.getDoc()?.version ?? doc.version;
    const { error } = await supabase().rpc('jsa_finalize', { p_id: doc.id, p_version: v });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast(`${doc.header.number} Rev ${doc.header.revision} finalized`); onDone();
  }
  return (
    <Modal title="Finalize JSA" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn green" disabled={!ok || busy || missing > 0} onClick={go}>{busy ? 'Finalizing…' : 'Finalize JSA'}</button></>}>
      <p style={{ marginTop: 0 }}><strong>{doc.header.number}</strong> · Rev {doc.header.revision} · {doc.activities.length} activities · {hazards.length} hazards</p>
      {missing > 0 && <div className="banner error">{missing} hazard{missing === 1 ? ' has' : 's have'} no control measures. Add controls to every hazard before finalizing.</div>}
      {blank > 0 && <div className="banner warn">{blank} empty control line{blank === 1 ? '' : 's'} will be ignored.</div>}
      <label className="jsa-check" style={{ alignItems: 'flex-start', lineHeight: 1.5 }}>
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ marginTop: 3 }} />
        <span>Confirm that you have reviewed the activities, hazards, control measures, and applicable site safety requirements.</span>
      </label>
      <p className="muted" style={{ marginBottom: 0 }}>A snapshot of this version is kept permanently. Finalization is an internal action and does not replace any approval required by TENARIS or the site permit process.</p>
    </Modal>
  );
}
