/**
 * Recognises a pasted table (Excel/Word TSV, markdown/pipe table) or a plain list of work activities and hazards,
 * the way they are normally supplied (No. | Work Activity | Risk / Hazard | Control Measures).
 * The result is only a proposal: the UI shows it for correction before anything is generated.
 */
import { OTHER_HAZARD, uid, type JActivity, type JHazard } from './types.ts';

export interface ParseResult { activities: JActivity[]; warnings: string[]; format: 'table' | 'list' | 'empty' }

/* ------------------------------------------------------------------ hazard category recognition */
const ALIASES: [RegExp, string][] = [
  [/overhead crane|\bcrane\b|hoist/i, 'Overhead Crane'],
  [/uncontrolled|swing(ing)? load|runaway|rolling|material.*motion|moving material|dropping of material/i, 'Material in Uncontrolled Motion'],
  [/falling object|dropped (object|tool|material)|struck by (a )?falling|objects? fall/i, 'Falling Objects'],
  [/working at height|work at height|scaffold|ladder|fall from (a )?height|height/i, 'Working at Height / Scaffold'],
  [/electr|shock|live (wire|cable|part)|energi[sz]ed|arc flash|cable/i, 'Electricity'],
  [/\bfire\b|hot work|spark|weld|flammable|explosi|burn/i, 'Fire'],
  [/chemical|solvent|paint|acid|thinner|fume|coating|cement dust|hazardous substance/i, 'Chemical Hazard'],
  [/lifting|carrying|ergonom|manual handling|back (strain|injur)|heavy (load|weight)/i, 'Lifting & Carrying'],
  [/slip|trip|same level|uneven (ground|surface)|wet surface/i, 'Slip, Trip & Falls'],
  [/vehicle|truck|reversing|traffic|forklift|lorry|\bcar\b|driving/i, 'On-Site Vehicle'],
  [/sharp|laceration|\bcuts?\b|puncture|jagged/i, 'Objects with Sharp Edges'],
  [/noise|loud|hearing/i, 'Noise'],
  [/lighting|illumination|poor visibility|darkness|\bdark\b/i, 'Inadequate Lighting'],
  [/biolog|insect|snake|scorpion|bacteria|virus|infect|mosquito|animal|bite/i, 'Biological Hazard'],
  [/interfer|simultaneous|adjacent (work|activit)|other (crews|contractors|trades)/i, 'Interference'],
  [/machin|grinder|jack ?hammer|rotating|moving parts|pinch|entangle|crush|caught in|power tool|equipment|vibration/i, 'Machinery & Equipment'],
  [/manual task|hand tool|hand-held|hand held|manual work|tools?\b/i, 'Manual Task & Tools'],
];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Maps free hazard text onto a category from the (editable) category list. Unknown text becomes a custom hazard. */
export function matchCategory(text: string, categories: string[]): { category: string; custom: string } {
  const t = text.trim();
  const n = norm(t);
  const exact = categories.find((c) => norm(c) === n);
  if (exact) return { category: exact, custom: '' };
  const contained = categories.filter((c) => c !== OTHER_HAZARD && n.length > 2 && (n.includes(norm(c)) || norm(c).includes(n)))
    .sort((a, b) => b.length - a.length)[0];
  if (contained) return { category: contained, custom: norm(contained) === n ? '' : t };
  for (const [re, cat] of ALIASES) if (re.test(t) && categories.includes(cat)) return { category: cat, custom: t };
  return { category: OTHER_HAZARD, custom: t };
}

/* ------------------------------------------------------------------ cell helpers */
const BULLET = /^\s*(?:[-*•▪●◦–—]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;
const stripBullet = (s: string) => s.replace(BULLET, '').trim();
const clean = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();

/** Splits a cell holding several numbered/bulleted/newline separated items into clean strings. */
export function splitItems(cell: string): string[] {
  let s = clean(cell);
  if (!s) return [];
  // "1. foo 2. bar 3. baz" written on one line
  if (!s.includes('\n') && /^\(?1[.)]\s/.test(s) && /\s\(?2[.)]\s/.test(s)) s = s.replace(/\s+(?=\(?\d{1,3}[.)]\s)/g, '\n');
  // wrapped continuation lines (a line that does not start a new item) join the previous item when the cell is numbered
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => BULLET.test(l)).length >= 2;
  const items: string[] = [];
  for (const l of lines) {
    if (numbered && !BULLET.test(l) && items.length) items[items.length - 1] += ' ' + l;
    else items.push(stripBullet(l));
  }
  return items.filter(Boolean);
}

function splitHazards(cell: string, categories: string[]): string[] {
  const parts = clean(cell).split(/\n|;|•/).map(stripBullet).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.includes(',')) {
      const bits = p.split(',').map((x) => x.trim()).filter(Boolean);
      const known = bits.filter((b) => matchCategory(b, categories).category !== OTHER_HAZARD);
      if (bits.length > 1 && known.length === bits.length) { out.push(...bits); continue; }
    }
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ table reading */
/** Reads delimiter separated text with "quoted, multi-line" cells (as Excel puts on the clipboard). */
export function readDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function readPipes(text: string): string[][] {
  return text.split(/\r?\n/).filter((l) => l.includes('|'))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((r) => r.some((c) => c) && !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
}

interface Cols { no: number; act: number; haz: number; ctl: number }

function detectColumns(header: string[] | null, first: string[]): Cols {
  if (header) {
    const find = (re: RegExp) => header.findIndex((h) => re.test(h));
    const cols = { no: find(/^(no\b|no\.|#|s\.?\s?n|sr|item)/i), act: find(/activit|task|job|step|work/i), haz: find(/hazard|risk|danger/i), ctl: find(/control|measure|precaution|mitigation|safeguard/i) };
    if (cols.act >= 0 && cols.haz >= 0) return cols;
  }
  const numFirst = /^\d{1,3}[.)]?$/.test(first[0]?.trim() ?? '') && first.length > 2;
  return numFirst ? { no: 0, act: 1, haz: 2, ctl: first.length > 3 ? 3 : -1 } : { no: -1, act: 0, haz: 1, ctl: first.length > 2 ? 2 : -1 };
}

const looksLikeHeader = (r: string[]) => {
  const t = r.join(' ');
  return /activit|task/i.test(t) && /hazard|risk|control/i.test(t) && r.every((c) => c.length < 60);
};

function fromTable(allRows: string[][], categories: string[]): ParseResult {
  const warnings: string[] = [];
  // a document title or footer line has no tabs at all (table rows keep a tab for every cell, even empty ones)
  const wide = allRows.filter((r) => r.length >= 3).length;
  const rows = wide * 2 >= allRows.length ? allRows.filter((r) => r.length > 1) : allRows;
  if (!rows.length) return { activities: [], warnings: ['No table rows were found.'], format: 'table' };
  const hi = rows.slice(0, 8).findIndex(looksLikeHeader);
  const header = hi >= 0 ? rows[hi].map((c) => c.trim()) : null;
  const body = hi >= 0 ? rows.slice(hi + 1) : rows;
  if (!body.length) return { activities: [], warnings: ['The table has a header but no rows.'], format: 'table' };
  const cols = detectColumns(header, body[0]);
  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : '');

  const activities: JActivity[] = [];
  let cur: JActivity | null = null;
  let lastHaz: JHazard | null = null;
  const addHazard = (a: JActivity, text: string): JHazard => {
    const m = matchCategory(text, categories);
    const key = (h: JHazard) => `${h.category}|${h.custom_name.toLowerCase()}`;
    const h: JHazard = { id: uid(), category: m.category, custom_name: m.custom, instructions: '', controls: [] };
    const dup = a.hazards.find((x) => key(x) === key(h));
    if (dup) return dup;
    a.hazards.push(h);
    return h;
  };

  body.forEach((r, idx) => {
    const actText = clean(cell(r, cols.act)).replace(/\n+/g, ' ').trim();
    const hazCell = cell(r, cols.haz);
    const ctlItems = splitItems(cell(r, cols.ctl));
    if (actText && !(cur && norm(cur.title) === norm(actText))) {
      cur = { id: uid(), title: stripBullet(actText), equipment: '', instructions: '', hazards: [] };
      activities.push(cur); lastHaz = null;
    } else if (!cur) {
      cur = { id: uid(), title: '', equipment: '', instructions: '', hazards: [] };
      activities.push(cur);
      warnings.push(`Row ${idx + 1}: no work activity found; a blank activity was created.`);
    }
    const hazards = splitHazards(hazCell, categories).map((t) => addHazard(cur!, t));
    if (hazards.length) lastHaz = hazards[0];
    if (ctlItems.length) {
      const target = hazards[0] ?? lastHaz;
      if (!target) { warnings.push(`Row ${idx + 1}: control measures found without a hazard — ignored.`); return; }
      if (hazards.length > 1) warnings.push(`Row ${idx + 1}: controls for several hazards were attached to "${hazards[0].custom_name || hazards[0].category}" — check them.`);
      for (const t of ctlItems) target.controls.push({ id: uid(), text: t, origin: 'manual', edited: false });
    }
  });
  const empty = activities.filter((a) => !a.title && !a.hazards.length);
  if (empty.length) warnings.push('Some empty rows were skipped.');
  return { activities: activities.filter((a) => a.title || a.hazards.length), warnings, format: 'table' };
}

/* ------------------------------------------------------------------ list reading */
function fromList(text: string, categories: string[]): ParseResult {
  const warnings: string[] = [];
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const activities: JActivity[] = [];
  let cur: JActivity | null = null;
  const addHaz = (a: JActivity, t: string) => {
    for (const piece of splitHazards(t, categories)) {
      const m = matchCategory(piece, categories);
      a.hazards.push({ id: uid(), category: m.category, custom_name: m.custom, instructions: '', controls: [] });
    }
  };
  const bulletRe = /^\s*[-*•▪●◦–—]\s+/;
  const hasBullets = lines.some((l) => bulletRe.test(l) || /^\s{2,}\S/.test(l));

  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:work\s+)?(?:activity|task|job)\s*(?:\d+)?\s*[:\-–]\s*(.+)$/i))) {
      const inline = m[1].split(/\s*(?:[-–—]|\|)?\s*(?:hazards?|risks?)\s*[:\-–]\s*/i);
      cur = { id: uid(), title: stripBullet(inline[0]).trim(), equipment: '', instructions: '', hazards: [] };
      activities.push(cur);
      if (inline[1]) addHaz(cur, inline[1]);
    } else if ((m = line.match(/^(?:hazards?|risks?|risk\s*\/\s*hazards?)\s*[:\-–]\s*(.+)$/i))) {
      if (!cur) { cur = { id: uid(), title: '', equipment: '', instructions: '', hazards: [] }; activities.push(cur); warnings.push('Hazards found before any work activity.'); }
      addHaz(cur, m[1]);
    } else if (hasBullets && (bulletRe.test(raw) || /^\s{2,}\S/.test(raw))) {
      if (!cur) { cur = { id: uid(), title: '', equipment: '', instructions: '', hazards: [] }; activities.push(cur); }
      addHaz(cur, stripBullet(line));
    } else if ((m = line.match(/^(.+?)\s+[-–—:]\s+(?:hazards?|risks?)\s*[:\-–]?\s*(.+)$/i))) {
      cur = { id: uid(), title: stripBullet(m[1]), equipment: '', instructions: '', hazards: [] };
      activities.push(cur); addHaz(cur, m[2]);
    } else {
      cur = { id: uid(), title: stripBullet(line), equipment: '', instructions: '', hazards: [] };
      activities.push(cur);
    }
  }
  if (activities.length && activities.every((a) => !a.hazards.length)) warnings.push('No hazards were recognised — add hazards to each activity below.');
  return { activities, warnings, format: 'list' };
}

/** Entry point: pick the right reader for whatever was pasted. */
export function parseActivities(text: string, categories: string[]): ParseResult {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return { activities: [], warnings: [], format: 'empty' };
  const lines = t.split(/\r?\n/);
  if (t.includes('\t')) {
    const rows = readDelimited(t, '\t');
    if (rows.some((r) => r.length > 1)) return fromTable(rows, categories);
  }
  if (lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2).length >= 2) return fromTable(readPipes(t), categories);
  return fromList(t, categories);
}
