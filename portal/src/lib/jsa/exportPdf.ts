'use client';
import { pdfSafe, type ExportModel } from './exportModel';
import type { LogoImage } from './exportDocx';

type Cell = string | { content: string; rowSpan?: number; colSpan?: number; styles?: Record<string, unknown> };

/** Builds the PDF in the browser (text stays selectable). Long control lists flow across pages; the table header repeats. */
export async function buildPdf(m: ExportModel, logo: LogoImage | null): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const t = pdfSafe;

  const doc = new jsPDF({ orientation: m.orientation, unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight();
  const mx = 10;
  const NAVY: [number, number, number] = [23, 32, 51]; const GREY: [number, number, number] = [243, 245, 249]; const LINE: [number, number, number] = [174, 182, 196];

  /* ---- title block */
  if (logo) { const h = 14; doc.addImage(logo.dataUrl, 'PNG', mx, 9, Math.min(48, (logo.width / logo.height) * h), h); }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...NAVY); doc.text(t(m.company), W - mx, 13, { align: 'right' });
  doc.setFontSize(11); if (m.draft) doc.setTextColor(184, 72, 72); doc.text(t(m.title + (m.draft ? ' - DRAFT' : '')), W - mx, 19, { align: 'right' });
  if (m.address) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(116, 123, 134); doc.text(t(m.address), W - mx, 23.5, { align: 'right' }); }

  /* ---- details */
  const body: Cell[][] = [];
  const small = m.meta.filter((x) => !x.wide);
  const lab = (s: string): Cell => ({ content: t(s), styles: { fontStyle: 'bold', fillColor: GREY, cellWidth: 30 } });
  for (let i = 0; i < small.length; i += 2) body.push([lab(small[i].label), t(small[i].value), lab(small[i + 1]?.label ?? ''), t(small[i + 1]?.value ?? '')]);
  m.meta.filter((x) => x.wide).forEach((x) => body.push([lab(x.label), { content: t(x.value), colSpan: 3 }]));
  autoTable(doc, { startY: 28, body: body as never, theme: 'grid', margin: { left: mx, right: mx },
    styles: { fontSize: 8, cellPadding: 1.6, lineColor: LINE, lineWidth: 0.1, textColor: [21, 23, 26], overflow: 'linebreak' } });

  /* ---- activities: one row per control. No row-spans (autoTable cannot split tall spanned rows), so the activity and
     hazard cells are drawn in the first row of their group and the borders between the rows of a group are removed. */
  const rows: Cell[][] = [];
  const labels: { no: string; act: string; haz: string }[] = [];
  const B = 0.1;
  const edge = (top: boolean, bottom: boolean) => ({ lineWidth: { top: top ? B : 0, bottom: bottom ? B : 0, left: B, right: B } });
  for (const a of m.activities) {
    const total = a.hazards.reduce((n, h) => n + Math.max(1, h.controls.length), 0);
    let at = 0;
    for (const h of a.hazards) {
      const list = h.controls.length ? h.controls : [''];
      list.forEach((c, i) => {
        const aFirst = at === 0; const aLast = at === total - 1;
        const hFirst = i === 0; const hLast = i === list.length - 1;
        rows.push([
          { content: aFirst ? String(a.no) : '', styles: { fontStyle: 'bold', halign: 'center', ...edge(aFirst, aLast) } },
          { content: aFirst ? t(a.title) + (a.equipment ? `
Equipment: ${t(a.equipment)}` : '') : '', styles: { fontStyle: 'bold', ...edge(aFirst, aLast) } },
          { content: hFirst ? t(h.name) : '', styles: { fontStyle: 'bold', ...edge(hFirst, hLast) } },
          { content: c ? String(i + 1) : '', styles: { halign: 'right', fontStyle: 'bold' } },
          { content: c ? t(c) : 'No control measures entered.', styles: c ? {} : { fontStyle: 'italic', textColor: [184, 72, 72] } },
        ]);
        labels.push({ no: String(a.no), act: t(a.title), haz: t(h.name) });
        at++;
      });
    }
  }
  const control = m.orientation === 'landscape' ? 'auto' : 'auto';
  autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5,
    head: [['No.', 'Work Activity', 'Risk / Hazard', '#', 'Control Measures']], body: rows as never,
    theme: 'grid', margin: { left: mx, right: mx, bottom: 14 }, showHead: 'everyPage', rowPageBreak: 'avoid',
    styles: { fontSize: 8, cellPadding: 1.8, lineColor: LINE, lineWidth: 0.1, valign: 'top', overflow: 'linebreak', textColor: [21, 23, 26] },
    headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold' },
    // a group that continues on a new page repeats its activity / hazard in grey so the page is never anonymous
    didDrawCell: (d) => {
      if (d.section !== 'body' || d.column.index > 2) return;
      const lb = labels[d.row.index]; if (!lb) return;
      const headH = d.table.head.reduce((n, r) => n + r.height, 0);
      const topOfPage = Math.abs(d.cell.y - (d.settings.margin.top + headH)) < 0.6;
      const blank = (d.cell.raw as { content?: string } | string | undefined) && typeof d.cell.raw === 'object' ? !(d.cell.raw as { content?: string }).content : !d.cell.raw;
      if (!topOfPage || !blank) return;
      const txt = d.column.index === 0 ? lb.no : d.column.index === 1 ? `(cont.) ${lb.act}` : `(cont.) ${lb.haz}`;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(116, 123, 134);
      doc.text(doc.splitTextToSize(txt, d.cell.width - 3) as string[], d.cell.x + (d.column.index === 0 ? d.cell.width / 2 : 1.8), d.cell.y + 4.6, d.column.index === 0 ? { align: 'center' } : undefined);
    },
    columnStyles: { 0: { cellWidth: 11 }, 1: { cellWidth: m.orientation === 'landscape' ? 48 : 34 }, 2: { cellWidth: m.orientation === 'landscape' ? 40 : 30 }, 3: { cellWidth: 8 }, 4: { cellWidth: control } },
  });

  /* ---- signature boxes (left blank: nothing is signed here) */
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  if (m.signatures.length) {
    if (y + 34 > H - 16) { doc.addPage(); y = 14; }
    autoTable(doc, { startY: y, head: [m.signatures.map(t)], body: [m.signatures.map(() => 'Name:\n\nSignature:\n\nDate:')], theme: 'grid', margin: { left: mx, right: mx },
      styles: { fontSize: 8, cellPadding: 2, lineColor: LINE, lineWidth: 0.1, minCellHeight: 26, textColor: [116, 123, 134] }, headStyles: { fillColor: GREY, textColor: NAVY, fontStyle: 'bold', minCellHeight: 6 }, rowPageBreak: 'avoid' });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  }
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(116, 123, 134);
  const note = doc.splitTextToSize(t(m.notice), W - mx * 2) as string[];
  if (y + note.length * 3.4 > H - 12) { doc.addPage(); y = 14; }
  doc.text(note, mx, y + 2);

  /* ---- every page: footer, page number and DRAFT watermark */
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(116, 123, 134);
    doc.text(t(`${m.company}  |  ${m.number}  |  Rev ${m.revision}${m.draft ? '  |  DRAFT' : ''}${m.footer ? '  |  ' + m.footer : ''}`), mx, H - 6);
    doc.text(`Page ${p} of ${pages}`, W - mx, H - 6, { align: 'right' });
    if (m.draft) {
      doc.saveGraphicsState();
      doc.setGState(new (doc as unknown as { GState: new (o: { opacity: number }) => object }).GState({ opacity: 0.11 }));
      doc.setFont('helvetica', 'bold'); doc.setFontSize(m.orientation === 'landscape' ? 130 : 110); doc.setTextColor(184, 72, 72);
      doc.text('DRAFT', W / 2, H / 2 + 14, { align: 'center', angle: 32 });
      doc.restoreGraphicsState();
    }
  }
  return doc.output('blob');
}
