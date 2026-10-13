'use client';
import type { ExportModel } from './exportModel';

export interface LogoImage { dataUrl: string; width: number; height: number }

/** Loads the company logo into a PNG data URL (browsers can't embed webp in Word/PDF directly). */
export async function loadLogo(src?: string): Promise<LogoImage | null> {
  if (!src) return null;
  try {
    const img = new Image(); img.crossOrigin = 'anonymous';
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('logo')); img.src = src; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
  } catch { return null; }
}

const dataUrlToBytes = (u: string) => Uint8Array.from(atob(u.split(',')[1]), (ch) => ch.charCodeAt(0));

export async function buildDocx(m: ExportModel, logo: LogoImage | null): Promise<Blob> {
  const d = await import('docx');
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, WidthType, AlignmentType, PageOrientation, Header, Footer, PageNumber, ImageRun, VerticalMergeType, BorderStyle, ShadingType, TableLayoutType } = d;

  const landscape = m.orientation === 'landscape';
  const pageW = landscape ? 16838 : 11906;                // A4 in twips
  const margin = 720;                                     // 12.7 mm
  const usable = pageW - margin * 2;
  const NAVY = '172033', GREY = 'F3F5F9';

  const border = { style: BorderStyle.SINGLE, size: 4, color: 'AEB6C4' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const run = (text: string, o: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}) => new TextRun({ text, bold: o.bold, size: o.size ?? 18, color: o.color, italics: o.italics, font: 'Calibri' });
  const para = (text: string, o: { bold?: boolean; size?: number; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; italics?: boolean } = {}) =>
    new Paragraph({ alignment: o.align, spacing: { after: o.after ?? 40 }, children: [run(text, o)] });
  const cell = (children: InstanceType<typeof Paragraph>[], w: number, o: { fill?: string; span?: number; vm?: (typeof VerticalMergeType)[keyof typeof VerticalMergeType] } = {}) =>
    new TableCell({ children, borders, width: { size: w, type: WidthType.DXA }, columnSpan: o.span, verticalMerge: o.vm, shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined, margins: { top: 50, bottom: 50, left: 90, right: 90 } });

  /* ---------------- title block */
  const titleRow = new Table({
    width: { size: usable, type: WidthType.DXA }, columnWidths: [Math.round(usable * 0.3), Math.round(usable * 0.7)], layout: TableLayoutType.FIXED,
    rows: [new TableRow({ children: [
      new TableCell({ borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }, width: { size: Math.round(usable * 0.3), type: WidthType.DXA },
        children: [new Paragraph({ children: logo ? [new ImageRun({ type: 'png', data: dataUrlToBytes(logo.dataUrl), transformation: { width: Math.min(150, (logo.width / logo.height) * 48), height: 48 } })] : [run(m.company, { bold: true, size: 22 })] })] }),
      new TableCell({ borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }, width: { size: Math.round(usable * 0.7), type: WidthType.DXA },
        children: [para(m.company, { bold: true, size: 26, align: AlignmentType.RIGHT, color: NAVY, after: 0 }), para(m.title + (m.draft ? ' — DRAFT' : ''), { bold: true, size: 22, align: AlignmentType.RIGHT, color: m.draft ? 'B84848' : NAVY, after: 0 }), ...(m.address ? [para(m.address, { size: 16, align: AlignmentType.RIGHT, color: '747B86' })] : [])] }),
    ] })],
  });

  /* ---------------- details (label/value pairs, wide items span the row) */
  const lw = Math.round(usable * 0.14), vw = Math.round(usable * 0.36);
  const detailRows: InstanceType<typeof TableRow>[] = [];
  const small = m.meta.filter((x) => !x.wide);
  for (let i = 0; i < small.length; i += 2) {
    const a = small[i], b = small[i + 1];
    detailRows.push(new TableRow({ children: [
      cell([para(a.label, { bold: true, size: 17 })], lw, { fill: GREY }), cell([para(a.value, { size: 18 })], vw),
      cell([para(b?.label ?? '', { bold: true, size: 17 })], lw, { fill: GREY }), cell([para(b?.value ?? '', { size: 18 })], vw),
    ] }));
  }
  m.meta.filter((x) => x.wide).forEach((x) => detailRows.push(new TableRow({ children: [
    cell([para(x.label, { bold: true, size: 17 })], lw, { fill: GREY }),
    cell(x.value.split('\n').map((l) => para(l, { size: 18 })), vw * 2 + lw, { span: 3 }),
  ] })));
  const details = new Table({ width: { size: usable, type: WidthType.DXA }, columnWidths: [lw, vw, lw, vw], layout: TableLayoutType.FIXED, rows: detailRows });

  /* ---------------- activities / hazards / controls */
  const W = landscape ? [0.05, 0.2, 0.18, 0.57] : [0.06, 0.2, 0.17, 0.57];
  const cw = W.map((x) => Math.round(usable * x));
  const head = new TableRow({ tableHeader: true, cantSplit: true, children: ['No.', 'Work Activity', 'Risk / Hazard', 'Control Measures'].map((t, i) => cell([para(t, { bold: true, size: 18, color: 'FFFFFF' })], cw[i], { fill: NAVY })) });
  const rows: InstanceType<typeof TableRow>[] = [head];
  for (const a of m.activities) {
    a.hazards.forEach((h, hi) => {
      const first = hi === 0;
      rows.push(new TableRow({ children: [
        cell([para(first ? String(a.no) : '', { bold: true })], cw[0], { vm: first ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE }),
        cell(first ? [para(a.title, { bold: true }), ...(a.equipment ? [para(`Equipment: ${a.equipment}`, { size: 16, color: '5B6472', italics: true })] : [])] : [para('')], cw[1], { vm: first ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE }),
        cell([para(h.name, { bold: true })], cw[2]),
        cell(h.controls.length
          ? h.controls.map((c, i) => new Paragraph({ spacing: { after: 50 }, indent: { left: 380, hanging: 380 }, children: [run(`${i + 1}.\t`, { bold: true }), run(c)], tabStops: [{ type: d.TabStopType.LEFT, position: 380 }] }))
          : [para('No control measures entered.', { italics: true, color: 'B84848' })], cw[3]),
      ] }));
    });
  }
  const main = new Table({ width: { size: usable, type: WidthType.DXA }, columnWidths: cw, layout: TableLayoutType.FIXED, rows });

  /* ---------------- signatures (blank boxes: nothing is signed or approved here) */
  const sigs = m.signatures.length ? new Table({
    width: { size: usable, type: WidthType.DXA }, layout: TableLayoutType.FIXED,
    columnWidths: m.signatures.map(() => Math.floor(usable / m.signatures.length)),
    rows: [new TableRow({ cantSplit: true, children: m.signatures.map((s) => cell([
      para(s, { bold: true, size: 17 }), para('Name:', { size: 16, color: '747B86', after: 220 }), para('Signature:', { size: 16, color: '747B86', after: 220 }), para('Date:', { size: 16, color: '747B86' }),
    ], Math.floor(usable / m.signatures.length))) })],
  }) : null;

  const spacer = () => new Paragraph({ spacing: { after: 160 }, children: [] });
  const children = [titleRow, spacer(), details, spacer(), main, spacer(), ...(sigs ? [sigs, spacer()] : []), para(m.notice, { size: 15, italics: true, color: '747B86' })];

  const doc = new Document({
    creator: m.company, title: `${m.number} Rev ${m.revision}`, description: m.title,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838, orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin: { top: 720, bottom: 720, left: margin, right: margin } } },
      headers: { default: new Header({ children: m.draft ? [para('DRAFT — NOT FINALIZED — NOT FOR SITE USE', { bold: true, size: 22, color: 'B84848', align: AlignmentType.CENTER })] : [para(`${m.number} · Revision ${m.revision}`, { size: 15, color: '747B86', align: AlignmentType.RIGHT })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        run(`${m.company}  ·  ${m.number}  ·  Rev ${m.revision}${m.draft ? '  ·  DRAFT' : ''}${m.footer ? '  ·  ' + m.footer : ''}  ·  Page `, { size: 15, color: '747B86' }),
        new TextRun({ children: [PageNumber.CURRENT], size: 15, color: '747B86' }), run(' of ', { size: 15, color: '747B86' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 15, color: '747B86' }),
      ] })] }) },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
