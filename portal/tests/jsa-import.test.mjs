// Import path: a Word JSA table -> mammoth -> table text -> parsed activities; and PDF text extraction.   node tests/jsa-import.test.mjs
import { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType } from 'docx';
import mammoth from 'mammoth';
import { jsPDF } from 'jspdf';
import { extractText, getDocumentProxy } from 'unpdf';
import { htmlToText } from '../src/lib/jsa/extractText.ts';
import { parseActivities } from '../src/lib/jsa/parse.ts';
import { DEFAULT_HAZARD_CATEGORIES as CATS } from '../src/lib/jsa/types.ts';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };

const cell = (lines) => new TableCell({ width: { size: 2000, type: WidthType.DXA }, children: lines.map((t) => new Paragraph(t)) });
const row = (...cols) => new TableRow({ children: cols.map((c) => cell(Array.isArray(c) ? c : [c])) });
const doc = new Document({ sections: [{ children: [
  new Paragraph('Job Safety Analysis — Concrete work'),
  new Table({ rows: [
    row('No.', 'Work Activity', 'Risk / Hazard', 'Control Measures'),
    row('1', 'Concrete cutting', ['Noise', 'Electricity'], ['1. Wear hearing protection.', '2. Apply LOTO before connecting the saw.']),
    row('', '', 'Machinery & Equipment', ['1. Inspect the guard.', '2. Check disc RPM.', '3. Keep hands clear of the blade.']),
    row('2', 'Scaffold erection', 'Working at Height / Scaffold', '1. Check the scaffold tag before use.'),
  ] }),
] }] });
const buf = Buffer.from(await Packer.toBuffer(doc));
const { value: html } = await mammoth.convertToHtml({ buffer: buf });
const text = htmlToText(html);
ok(text.includes('\t') && /Concrete cutting/.test(text), 'Word table became tab-separated rows');
const r = parseActivities(text, CATS);
ok(r.format === 'table' && r.activities.length === 2, `two activities recognised (got ${r.activities.length})`);
const a1 = r.activities[0];
ok(a1.title === 'Concrete cutting' && a1.hazards.map((h) => h.category).join() === 'Noise,Electricity,Machinery & Equipment', 'hazards incl. continuation row (blank activity cell)');
const mach = a1.hazards[2];
ok(mach.controls.length === 3 && mach.controls[1].text === 'Check disc RPM.', 'numbered controls split, numbering removed');
ok(r.activities[1].hazards[0].controls[0].text === 'Check the scaffold tag before use.', 'single-line control kept');
ok(r.warnings.some((w) => /several hazards/.test(w)), 'warns that controls of a multi-hazard row were attached to the first hazard');

// PDF text extraction (same call as the route)
const pdf = new jsPDF(); pdf.text('Work at height requires a valid scaffold tag.', 10, 20); pdf.text('1. Check guardrails before use.', 10, 30);
const proxy = await getDocumentProxy(new Uint8Array(pdf.output('arraybuffer')));
const out = await extractText(proxy, { mergePages: true });
const t = Array.isArray(out.text) ? out.text.join('\n') : out.text;
ok(/scaffold tag/.test(t) && /guardrails/.test(t), 'PDF text extracted');

console.log(failed ? `\n${failed} FAILED` : '\nAll import tests passed');
process.exit(failed ? 1 : 0);
