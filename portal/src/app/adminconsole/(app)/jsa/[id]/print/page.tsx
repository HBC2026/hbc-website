'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { JsaGuard } from '@/components/jsa/common';
import { JsaPaper } from '@/components/jsa/JsaPaper';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead, Select } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { loadJsa } from '@/lib/jsa/client';
import { logoUrl } from '@/lib/jsa/exportFiles';
import { buildExport } from '@/lib/jsa/exportModel';
import type { JsaDoc, JsaRevision } from '@/lib/jsa/types';
import { useJsaSettings } from '@/lib/jsa/useSettings';
import { supabase, unwrap } from '@/lib/supabase';

export default function PrintPage() {
  return <JsaGuard><Inner /></JsaGuard>;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { settings: app } = useApp();
  const { settings } = useJsaSettings();
  const rev = search.get('rev');
  const tplId = search.get('tpl') ?? settings.export_templates[0]?.id;
  const orient = (search.get('o') as 'portrait' | 'landscape' | null) ?? undefined;

  const { data, error, loading } = useQuery(async () => {
    if (rev) {
      const r = unwrap(await supabase().from('jsa_revisions').select('revision, created_at, snapshot').eq('jsa_id', id).eq('revision', Number(rev)).single()) as JsaRevision;
      return { header: { ...r.snapshot.header, status: 'finalized' as const }, activities: r.snapshot.activities, finalizedAt: r.created_at };
    }
    const d = (await loadJsa(id)) as JsaDoc | null;
    if (!d) throw new Error('JSA not found');
    return { header: d.header, activities: d.activities, finalizedAt: d.finalized_at };
  }, [id, rev]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? 'Not found'} />;
  const tpl = settings.export_templates.find((t) => t.id === tplId) ?? settings.export_templates[0];
  const model = buildExport({ header: data.header, activities: data.activities, company: { name: app.company.name, logo: logoUrl(app.company.logo), address: app.company.address }, template: tpl, finalizedAt: data.finalizedAt, orientation: orient });
  const go = (t: string, o?: string) => router.replace(`/adminconsole/jsa/${id}/print?${rev ? `rev=${rev}&` : ''}tpl=${encodeURIComponent(t)}${o ? `&o=${o}` : ''}`);

  return (
    <>
      <style>{`@page { size: A4 ${model.orientation}; margin: 9mm; } @media print { body { background: #fff; } }`}</style>
      <PageHead eyebrow="Print preview" title={`${data.header.number} · Rev ${data.header.revision}`} sub={model.draft ? 'Draft — printed copies are marked DRAFT' : 'Finalized'}>
        <Select className="select" value={tpl.id} onChange={(e) => go(e.target.value, orient)} aria-label="Template">
          {settings.export_templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select className="select" value={orient ?? ''} onChange={(e) => go(tpl.id, e.target.value)} aria-label="Orientation">
          <option value="">Template default</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option>
        </Select>
        <button className="btn primary" onClick={() => window.print()} title="Choose “Save as PDF” in the print dialog to save a copy">🖨 Print / Save as PDF</button>
        <Link className="btn" href={`/adminconsole/jsa/${id}?tab=export`}>← Back</Link>
      </PageHead>
      <JsaPaper m={model} />
    </>
  );
}
