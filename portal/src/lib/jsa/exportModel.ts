/** Renderer-independent description of a JSA document, shared by the print preview, Word and PDF exports. */
import { hazardName, REVIEW_NOTICE, type ExportTemplate, type JActivity, type JsaHeader } from './types.ts';

export interface ExportInput {
  header: JsaHeader; activities: JActivity[];
  company: { name: string; logo?: string; address?: string };
  template: ExportTemplate;
  finalizedAt?: string | null;
  orientation?: 'portrait' | 'landscape';       // overrides the template
}
export interface ExportHazard { name: string; controls: string[] }
export interface ExportActivity { no: number; title: string; equipment: string; hazards: ExportHazard[] }
export interface ExportModel {
  title: string; company: string; address: string; logo?: string; draft: boolean; revision: number; number: string;
  orientation: 'portrait' | 'landscape';
  meta: { label: string; value: string; wide?: boolean }[];
  activities: ExportActivity[];
  signatures: string[]; footer: string; notice: string; fileBase: string;
}

const fmtDate = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}`;
};

export function buildExport(i: ExportInput): ExportModel {
  const h = i.header;
  const draft = h.status !== 'finalized';
  const meta: ExportModel['meta'] = [
    { label: 'JSA Number', value: h.number }, { label: 'Revision', value: String(h.revision) },
    { label: 'Project', value: h.project }, { label: 'Client', value: h.client },
    { label: 'Work Location', value: h.location }, { label: 'Date', value: fmtDate(h.jsa_date) },
    { label: 'Prepared By', value: h.prepared_by }, { label: 'Status', value: draft ? 'DRAFT' : `Finalized${i.finalizedAt ? ' ' + fmtDate(i.finalizedAt) : ''}` },
    { label: 'Work Description', value: h.work_description, wide: true },
    { label: 'Equipment / Tools', value: h.equipment, wide: true },
  ];
  if (h.additional_instructions.trim()) meta.push({ label: 'Additional Safety Instructions', value: h.additional_instructions, wide: true });
  return {
    title: 'JOB SAFETY ANALYSIS (JSA)', company: i.company.name, address: i.company.address ?? '', logo: i.template.showLogo ? i.company.logo : undefined,
    draft, revision: h.revision, number: h.number, orientation: i.orientation ?? i.template.orientation,
    meta: meta.filter((m) => m.value.trim() || !m.wide),
    activities: i.activities.map((a, n) => ({
      no: n + 1, title: a.title, equipment: a.equipment,
      hazards: (a.hazards.length ? a.hazards : [{ category: '—', custom_name: '', controls: [] }]).map((hz) => ({
        name: 'id' in hz ? hazardName(hz) : '—', controls: hz.controls.map((c) => c.text),
      })),
    })),
    signatures: i.template.signatures, footer: i.template.footer, notice: REVIEW_NOTICE,
    fileBase: `${h.number || 'JSA'}_Rev${h.revision}${draft ? '_DRAFT' : ''}`.replace(/[^\w.-]+/g, '_'),
  };
}

/** Characters outside WinAnsi cannot be drawn with the built-in PDF fonts. */
export function pdfSafe(s: string): string {
  return s
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/≥/g, '>=').replace(/≤/g, '<=')
    .replace(/→/g, '->').replace(/×/g, 'x').replace(/[•●]/g, '-').replace(/…/g, '...').replace(/[–—]/g, '-')
    .replace(/ /g, ' ').replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '?');
}
