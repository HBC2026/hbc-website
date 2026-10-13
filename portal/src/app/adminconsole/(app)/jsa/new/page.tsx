'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { JsaGuard } from '@/components/jsa/common';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { createJsa } from '@/lib/jsa/client';
import type { JsaTemplate } from '@/lib/jsa/types';
import { supabase, unwrap } from '@/lib/supabase';

export default function NewJsa() {
  return <JsaGuard><Inner /></JsaGuard>;
}

function Inner() {
  const { toast, confirmDialog } = useApp();
  const router = useRouter();
  const sb = supabase();
  const [busy, setBusy] = useState(false);
  const { data, error, loading } = useQuery(async () =>
    unwrap(await sb.from('jsa_templates').select('id, name, description, content, updated_at').is('deleted_at', null).order('name')) as JsaTemplate[], []);

  async function create(tpl?: JsaTemplate) {
    if (tpl && !(await confirmDialog({
      title: 'Review before use',
      message: `“${tpl.name}” is a reusable starting point. Its activities, hazards and controls must be reviewed for suitability for this specific job before the JSA is finalized.`,
      confirmLabel: 'Use template',
    }))) return;
    setBusy(true);
    try {
      const id = await createJsa({}, tpl?.content.activities ?? []);
      router.replace(`/adminconsole/jsa/${id}${tpl ? '?tab=activities' : ''}`);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); setBusy(false); }
  }

  return (
    <>
      <PageHead eyebrow="JSA Management" title="New JSA" sub="Start from a blank JSA or from a reusable template. The JSA is saved as a draft immediately.">
        <Link href="/adminconsole/jsa" className="btn">← Dashboard</Link>
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="jsa-cards">
        <button className="jsa-card primary" disabled={busy} onClick={() => create()}>
          <div className="jsa-card-title">＋ Blank JSA</div>
          <div className="muted">Enter the job details, then add or paste the work activities and hazards.</div>
        </button>
        {loading ? <Loading /> : (data ?? []).map((t) => (
          <button key={t.id} className="jsa-card" disabled={busy} onClick={() => create(t)}>
            <div className="jsa-card-title">{t.name}</div>
            <div className="muted">{t.description || 'Template'}</div>
            <div className="muted" style={{ marginTop: 8, fontSize: 10 }}>{t.content.activities.length} activities · {t.content.activities.reduce((n, a) => n + a.hazards.length, 0)} hazards</div>
          </button>
        ))}
      </div>
      {!loading && (data ?? []).length === 0 && (
        <div className="banner" style={{ marginTop: 16 }}>No templates yet. <Link href="/adminconsole/jsa/templates" className="strong">Open JSA Templates</Link> to load the starter set (Concrete Cutting, Welding, Scaffolding and more).</div>
      )}
    </>
  );
}
