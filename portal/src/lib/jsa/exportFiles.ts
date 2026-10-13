'use client';
import { asset } from '@/lib/supabase';
import { buildDocx, loadLogo } from './exportDocx';
import type { ExportModel } from './exportModel';
import { buildPdf } from './exportPdf';

export const logoUrl = (logo?: string) => (logo ? asset(logo) : undefined);

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function downloadWord(m: ExportModel) {
  save(await buildDocx(m, await loadLogo(m.logo)), `${m.fileBase}.docx`);
}
export async function downloadPdf(m: ExportModel) {
  save(await buildPdf(m, await loadLogo(m.logo)), `${m.fileBase}.pdf`);
}
