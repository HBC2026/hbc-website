'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActivitiesTab } from '@/components/jsa/ActivitiesTab';
import { JsaGuard, JsaStatusBadge, ReviewNotice, SaveBadge } from '@/components/jsa/common';
import { DetailsTab } from '@/components/jsa/DetailsTab';
import { EditorTab } from '@/components/jsa/EditorTab';
import { ExportTab, FinalizeModal, HistoryTab } from '@/components/jsa/ExportTab';
import { GeneratorTab } from '@/components/jsa/GeneratorTab';
import { ErrorBox, Loading, PageHead, Tabs } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { useGenerator } from '@/lib/jsa/useGenerator';
import { useJsaDoc } from '@/lib/jsa/useJsaDoc';
import { useJsaSettings } from '@/lib/jsa/useSettings';
import { supabase } from '@/lib/supabase';

type Tab = 'details' | 'activities' | 'generator' | 'editor' | 'export' | 'history';
const TABS: Tab[] = ['details', 'activities', 'generator', 'editor', 'export', 'history'];

export default function JsaWorkspacePage() {
  return <JsaGuard><Workspace /></JsaGuard>;
}

function Workspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const q = search.get('tab') as Tab | null;
  const tab: Tab = q && TABS.includes(q) ? q : 'details';
  const setTab = (t: Tab) => router.replace(`/adminconsole/jsa/${id}?tab=${t}`, { scroll: false });

  const ed = useJsaDoc(id);
  const { settings } = useJsaSettings();
  const gen = useGenerator(ed, settings);
  const [finalizing, setFinalizing] = useState(false);
  const projects = useQuery(async () => {
    const { data } = await supabase().from('jsas').select('project').neq('project', '').limit(500);
    return Array.from(new Set((data ?? []).map((r: { project: string }) => r.project))).sort();
  }, []);

  // Ctrl+S saves; Ctrl+Z / Ctrl+Y undo / redo when the cursor is not inside a text field (text fields keep their own undo)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const inField = /^(input|textarea)$/i.test((e.target as HTMLElement)?.tagName ?? '');
      if (k === 's') { e.preventDefault(); ed.save(); }
      else if (!inField && k === 'z') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); }
      else if (!inField && k === 'y') { e.preventDefault(); ed.redo(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (ed.loading && !ed.doc) return <Loading />;
  if (ed.loadError || !ed.doc) return <><ErrorBox error={ed.loadError ?? 'JSA not found'} /><Link className="btn" href="/adminconsole/jsa">← Dashboard</Link></>;
  const doc = ed.doc;
  const controls = doc.activities.reduce((n, a) => n + a.hazards.reduce((m, h) => m + h.controls.length, 0), 0);
  const hazards = doc.activities.reduce((n, a) => n + a.hazards.length, 0);

  return (
    <>
      <PageHead eyebrow="JSA Management" title={doc.header.number || 'JSA'} sub={[doc.header.project, doc.header.work_description].filter(Boolean).join(' — ').slice(0, 160) || 'Untitled job'}>
        <JsaStatusBadge s={doc.header.status} revision={doc.header.revision} />
        {!ed.locked && <>
          <SaveBadge state={ed.saveState} error={ed.saveError} savedAt={ed.savedAt} />
          <button className="btn sm" disabled={!ed.canUndo} onClick={ed.undo} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className="btn sm" disabled={!ed.canRedo} onClick={ed.redo} title="Redo (Ctrl+Y)">↷ Redo</button>
          <button className="btn" onClick={() => ed.save()} disabled={ed.saveState === 'saving'} title="Save (Ctrl+S)">Save</button>
          <button className="btn green" onClick={async () => { if (await ed.save()) setFinalizing(true); }}>✓ Finalize</button>
        </>}
        <Link className="btn" href="/adminconsole/jsa">← Dashboard</Link>
      </PageHead>

      {ed.saveState === 'error' && (
        <div className="banner error">
          <strong>Your latest changes are not saved:</strong> {ed.saveError}{' '}
          <button className="btn sm" onClick={() => ed.save()}>Retry</button>{' '}
          {/changed elsewhere/i.test(ed.saveError ?? '') && <button className="btn sm danger" onClick={() => ed.reload()}>Reload (discards local changes)</button>}
        </div>
      )}
      {doc.header.status === 'draft' && controls > 0 && tab !== 'export' && <ReviewNotice />}

      <Tabs value={tab} onChange={setTab} tabs={[
        ['details', 'Details'],
        ['activities', `Activities & Hazards (${doc.activities.length}/${hazards})`],
        ['generator', '✦ AI Generator'],
        ['editor', `Editor (${controls})`],
        ['export', 'Preview & Export'],
        ['history', 'Finalize & History'],
      ]} />

      {tab === 'details' && <DetailsTab ed={ed} projects={projects.data ?? []} />}
      {tab === 'activities' && <ActivitiesTab ed={ed} settings={settings} />}
      {tab === 'generator' && <GeneratorTab ed={ed} gen={gen} settings={settings} />}
      {tab === 'editor' && <EditorTab ed={ed} gen={gen} settings={settings} />}
      {tab === 'export' && <ExportTab ed={ed} settings={settings} />}
      {tab === 'history' && <HistoryTab ed={ed} settings={settings} onChanged={() => { /* reloaded by the tab */ }} />}
      {finalizing && <FinalizeModal ed={ed} onClose={() => setFinalizing(false)} onDone={async () => { setFinalizing(false); await ed.reload(); setTab('history'); }} />}
    </>
  );
}
