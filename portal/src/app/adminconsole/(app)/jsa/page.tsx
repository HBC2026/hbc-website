'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { JsaGuard, JsaStatusBadge } from '@/components/jsa/common';
import { useApp } from '@/components/Providers';
import { DatePicker, ErrorBox, Loading, PageHead, Select, StatCard } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { JsaRow } from '@/lib/jsa/types';
import { supabase, unwrap } from '@/lib/supabase';

export default function JsaDashboard() {
  return <JsaGuard><Dashboard /></JsaGuard>;
}

function Dashboard() {
  const { toast, confirmDialog } = useApp();
  const router = useRouter();
  const sb = supabase();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [project, setProject] = useState('');
  const [activity, setActivity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, error, loading, reload } = useQuery(async () => {
    const [rows, acts, tpl] = await Promise.all([
      sb.from('jsas').select('id, number, revision, status, project, client, location, work_description, jsa_date, prepared_by, updated_at, created_at, deleted_at').order('updated_at', { ascending: false }).limit(2000),
      sb.from('jsa_activities').select('jsa_id, title').limit(20000),
      sb.from('jsa_templates').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    ]);
    const activities = new Map<string, string>();
    ((unwrap(acts) ?? []) as { jsa_id: string; title: string }[]).forEach((a) => activities.set(a.jsa_id, `${activities.get(a.jsa_id) ?? ''} ${a.title}`.trim()));
    return { rows: unwrap(rows) as JsaRow[], activities, templates: tpl.count ?? 0 };
  }, []);

  const live = useMemo(() => (data?.rows ?? []).filter((r) => !r.deleted_at), [data]);
  const projects = useMemo(() => Array.from(new Set(live.map((r) => r.project).filter(Boolean))).sort(), [live]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => {
    if (!!r.deleted_at !== showDeleted) return false;
    if (status && r.status !== status) return false;
    if (project && r.project !== project) return false;
    if (from && r.jsa_date < from) return false;
    if (to && r.jsa_date > to) return false;
    if (activity && !(data!.activities.get(r.id) ?? '').toLowerCase().includes(activity.toLowerCase())) return false;
    return `${r.number} ${r.project} ${r.work_description} ${r.client} ${r.location}`.toLowerCase().includes(q.toLowerCase());
  }), [data, q, status, project, from, to, activity, showDeleted]);

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : String(e), true); } finally { setBusy(null); }
  }
  const duplicate = (r: JsaRow) => run(r.id, async () => {
    const { data: id, error } = await sb.rpc('jsa_duplicate', { p_id: r.id });
    if (error) throw new Error(error.message);
    toast('Duplicated as a new draft'); router.push(`/adminconsole/jsa/${id}`);
  });
  const remove = (r: JsaRow) => run(r.id, async () => {
    if (!(await confirmDialog({ title: 'Delete JSA?', message: `${r.number} will be moved to Deleted. You can restore it later; nothing is permanently removed.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.rpc('jsa_delete', { p_id: r.id });
    if (error) throw new Error(error.message);
    toast('JSA deleted'); reload();
  });
  const restore = (r: JsaRow) => run(r.id, async () => {
    const { error } = await sb.rpc('jsa_restore', { p_id: r.id });
    if (error) throw new Error(error.message);
    toast('JSA restored'); reload();
  });

  const drafts = live.filter((r) => r.status === 'draft').length;
  const recent = live.slice(0, 5);
  const filtered = !!(q || status || project || from || to || activity);

  return (
    <>
      <PageHead eyebrow="JSA Management" title="Job Safety Analysis" sub="Create, generate with AI, review, finalize and export JSAs">
        <Link href="/adminconsole/jsa/templates" className="btn">Templates</Link>
        <Link href="/adminconsole/jsa/new" className="btn primary">＋ New JSA</Link>
      </PageHead>
      {error && <ErrorBox error={error} />}
      {error && /does not exist|schema cache/i.test(error) && <div className="banner warn">The JSA database tables are missing. Run <code>supabase/migrations/0017_jsa.sql</code> in the Supabase SQL editor, then reload.</div>}

      <div className="stats">
        <StatCard label="Total JSAs" icon="⛑" value={live.length} note="Excluding deleted" />
        <StatCard label="Draft" icon="✎" value={drafts} note="Editable, AI available" />
        <StatCard label="Finalized" icon="✓" value={live.length - drafts} note="Reviewed and confirmed" />
        <StatCard label="Saved templates" icon="▣" value={data?.templates ?? 0} href="/adminconsole/jsa/templates" note="Reusable starting points" />
      </div>

      {recent.length > 0 && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-title">Recently modified</div>
          <div className="jsa-recent">
            {recent.map((r) => (
              <Link key={r.id} href={`/adminconsole/jsa/${r.id}`} className="jsa-recent-item">
                <div className="strong mono">{r.number}</div>
                <div className="jsa-clip">{r.work_description || r.project || 'Untitled JSA'}</div>
                <div className="muted" style={{ fontSize: 10 }}>{fmtDateTime(r.updated_at)}</div>
                <JsaStatusBadge s={r.status} revision={r.revision} />
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" placeholder="Search number, project, description…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
            <Select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All statuses</option><option value="draft">Draft</option><option value="finalized">Finalized</option>
            </Select>
            <Select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <input className="input" placeholder="Work activity…" value={activity} onChange={(e) => setActivity(e.target.value)} style={{ minWidth: 150 }} />
            <DatePicker className="input" value={from} onChange={setFrom} /><span className="muted">to</span><DatePicker className="input" value={to} onChange={setTo} />
            {filtered && <button className="btn sm" onClick={() => { setQ(''); setStatus(''); setProject(''); setActivity(''); setFrom(''); setTo(''); }}>Clear</button>}
            <label className="jsa-check"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted</label>
          </div>
          <span className="muted">{rows.length} JSAs</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>JSA Number</th><th>Project</th><th>Work Description</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="strong mono">{r.number}{r.revision > 0 && <span className="muted"> · R{r.revision}</span>}</td>
                  <td>{r.project || <span className="muted">—</span>}</td>
                  <td className="jsa-desc">{r.work_description || <span className="muted">—</span>}</td>
                  <td>{fmtDate(r.jsa_date)}</td>
                  <td><JsaStatusBadge s={r.status} /></td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {r.deleted_at ? (
                      <button className="btn sm" disabled={busy === r.id} onClick={() => restore(r)}>Restore</button>
                    ) : (
                      <>
                        <Link className="btn sm" href={`/adminconsole/jsa/${r.id}`}>Open</Link>{' '}
                        <Link className="btn sm" href={`/adminconsole/jsa/${r.id}?tab=${r.status === 'draft' ? 'editor' : 'history'}`}>{r.status === 'draft' ? 'Edit' : 'Revise'}</Link>{' '}
                        <button className="btn sm" disabled={busy === r.id} onClick={() => duplicate(r)}>Duplicate</button>{' '}
                        <Link className="btn sm" href={`/adminconsole/jsa/${r.id}?tab=export`}>Export</Link>{' '}
                        <button className="btn sm danger" disabled={busy === r.id} onClick={() => remove(r)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}><div className="empty">{live.length === 0 && !showDeleted ? 'No JSAs yet. Click “New JSA” to create the first one.' : 'No JSAs match the filters.'}</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
