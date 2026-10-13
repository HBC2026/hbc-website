/** Validation of AI output. AI text is untrusted: it is checked, cleaned and de-duplicated before it can reach the document. */
import { isDuplicate } from './dedupe.ts';

export const MAX_CONTROL_LEN = 900;
export const MIN_CONTROL_LEN = 12;

/** Phrases that are never acceptable as a control (the brief forbids pointing at other hazards' controls). */
const FORBIDDEN = [
  /\bsame (controls?|measures?|as)\b/i, /\bas (above|per above|mentioned above|stated above)\b/i,
  /\bsee (above|previous|hazard)\b/i, /\brefer to (above|previous)\b/i, /^n\/?a\.?$/i, /^etc\.?$/i,
];

export function cleanControl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/<[^>]*>/g, ' ')                                  // strip any markup
    .replace(/^\s*(?:[-*•–]|\(?\d{1,3}[.)])\s+/, '')            // leading bullet / numbering: numbering is automatic
    .replace(/\*\*|__|`/g, '')                                  // markdown emphasis
    .replace(/\s+/g, ' ').trim();
  if (s.length > MAX_CONTROL_LEN) s = s.slice(0, MAX_CONTROL_LEN).replace(/\s+\S*$/, '').trim() + '…';
  return s;
}

export interface ValidatedControls { controls: string[]; dropped: { text: string; reason: string }[] }

/** Cleans, rejects forbidden/too-short items and removes duplicates (also against `existing` controls). */
export function validateControls(raw: unknown, existing: string[] = []): ValidatedControls {
  const list = Array.isArray(raw) ? raw : [];
  const controls: string[] = [];
  const dropped: { text: string; reason: string }[] = [];
  for (const item of list) {
    const text = cleanControl(typeof item === 'object' && item !== null ? (item as { text?: unknown }).text : item);
    if (!text) continue;
    if (text.length < MIN_CONTROL_LEN) { dropped.push({ text, reason: 'too short' }); continue; }
    if (FORBIDDEN.some((re) => re.test(text))) { dropped.push({ text, reason: 'refers to other controls' }); continue; }
    if (isDuplicate(text, [...existing, ...controls])) { dropped.push({ text, reason: 'duplicate' }); continue; }
    controls.push(text);
  }
  return { controls, dropped };
}

/* ---- coverage checks: flags a hazard whose controls miss a mandatory topic (advisory only; never blocks) ---- */
interface Rule { test: RegExp; topic: string }
const has = (controls: string[], re: RegExp) => controls.some((c) => re.test(c));

const COVERAGE: { match: RegExp; rules: Rule[] }[] = [
  { match: /electric/i, rules: [
    { test: /lock.?out|loto/i, topic: 'LOTO applied by authorised client personnel' },
    { test: /absence of voltage|zero.?energy|de-?energi[sz]|isolation/i, topic: 'verification of isolation / absence of voltage' },
    { test: /electrician/i, topic: 'connections by authorised electricians' }] },
  { match: /fire|hot work|weld/i, rules: [
    { test: /hot work permit/i, topic: 'Hot Work Permit' }, { test: /fire watch/i, topic: 'Fire Watch' },
    { test: /extinguisher/i, topic: 'fire extinguishers' }, { test: /combustible/i, topic: 'removal of combustibles' }] },
  { match: /height|scaffold/i, rules: [
    { test: /scaffold tag|green tag|\btag\b/i, topic: 'scaffold inspection tag' }, { test: /guardrail|handrail/i, topic: 'guardrails' },
    { test: /harness|fall (protection|arrest)|lanyard/i, topic: 'fall protection based on exposure' }] },
  { match: /vehicle/i, rules: [
    { test: /banksman|flagman|spotter/i, topic: 'banksman' }, { test: /checklist/i, topic: 'vehicle checklist' },
    { test: /pedestrian/i, topic: 'pedestrian segregation' }] },
  { match: /chemical/i, rules: [
    { test: /sds|msds/i, topic: 'SDS / MSDS' }, { test: /spill/i, topic: 'spill response' },
    { test: /waste|dispos/i, topic: 'waste disposal' }] },
  { match: /machinery|equipment|manual task|tools/i, rules: [
    { test: /inspect/i, topic: 'pre-use inspection' }, { test: /guard/i, topic: 'guards' }] },
];
const GENERAL: Rule[] = [
  { test: /\bjsa\b|job safety analysis/i, topic: 'approved JSA' }, { test: /permit/i, topic: 'valid work permit' },
  { test: /toolbox/i, topic: 'toolbox talk' }, { test: /\bppe\b|protective equipment/i, topic: 'PPE' },
  { test: /stop.?work|stop the work/i, topic: 'stop-work conditions' }, { test: /housekeep/i, topic: 'housekeeping' },
];

/** Topics from the mandatory list that are missing from a hazard's controls. Advisory. */
export function coverageGaps(category: string, controls: string[]): string[] {
  const gaps: string[] = [];
  for (const g of COVERAGE) if (g.match.test(category)) for (const r of g.rules) if (!has(controls, r.test)) gaps.push(r.topic);
  if (controls.length >= 8) for (const r of GENERAL) if (!has(controls, r.test)) gaps.push(r.topic);
  return Array.from(new Set(gaps));
}
