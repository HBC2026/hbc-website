// Unit tests for the pure JSA libraries.  node tests/jsa.test.mjs   (Node 22.18+ strips TypeScript types natively)
import { parseActivities, matchCategory, splitItems } from '../src/lib/jsa/parse.ts';
import { validateControls, coverageGaps, cleanControl } from '../src/lib/jsa/validate.ts';
import { planGeneration, applyGeneration, replaceSelected, isProtected } from '../src/lib/jsa/merge.ts';
import { isDuplicate, similarity } from '../src/lib/jsa/dedupe.ts';
import { DEFAULT_HAZARD_CATEGORIES as CATS, OTHER_HAZARD, hazardName } from '../src/lib/jsa/types.ts';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };

// ---- category matching
ok(matchCategory('Noise', CATS).category === 'Noise', 'exact category');
ok(matchCategory('noise from jackhammer', CATS).category === 'Noise', 'category found inside text');
ok(matchCategory('Electric shock', CATS).category === 'Electricity', 'alias: electric shock');
ok(matchCategory('Fall from height', CATS).category === 'Working at Height / Scaffold', 'alias: fall from height');
ok(matchCategory('Dust inhalation silica', CATS).category === OTHER_HAZARD, 'unknown -> custom');
ok(matchCategory('Dust inhalation silica', CATS).custom === 'Dust inhalation silica', 'custom text kept');
ok(matchCategory('Radiation', ['Radiation', OTHER_HAZARD]).category === 'Radiation', 'admin-added category is matched');

// ---- tab separated (Excel/Word paste) with header and merged activity cells
const tsv = [
  'No.\tWork Activity\tRisk / Hazard\tControl Measures',
  '1\tConcrete cutting\tNoise\t"1. Wear ear plugs\n2. Limit exposure time"',
  '\t\tElectricity\t',
  '2\tScaffold erection\tWorking at Height / Scaffold; Falling Objects\t',
].join('\n');
let r = parseActivities(tsv, CATS);
ok(r.format === 'table' && r.activities.length === 2, 'TSV: two activities');
ok(r.activities[0].hazards.length === 2 && r.activities[0].hazards[1].category === 'Electricity', 'TSV: blank activity cell continues previous activity');
ok(r.activities[0].hazards[0].controls.length === 2 && r.activities[0].hazards[0].controls[0].text === 'Wear ear plugs', 'TSV: numbered controls split and numbering stripped');
ok(r.activities[1].hazards.length === 2, 'TSV: several hazards in one cell');

// ---- quoted multi-line cell (Excel)
const q = 'Activity\tHazard\tControls\nGrinding\t"Noise\nSharp edges"\t"1. Guard fitted 2. Disc checked"';
r = parseActivities(q, CATS);
ok(r.activities[0].hazards.map((h) => h.category).join() === 'Noise,Objects with Sharp Edges', 'quoted multi-line hazard cell');
ok(r.activities[0].hazards[0].controls.length === 2, 'controls numbered on one line are split');
ok(r.warnings.some((w) => /several hazards/.test(w)), 'warns when controls cover several hazards');

// ---- markdown table
const md = `| No. | Work Activity | Risk / Hazard | Control Measures |
|---|---|---|---|
| 1 | Cable pulling | Electricity<br>Manual Task & Tools | Isolate supply<br>Use gloves |
| 2 | Painting | Chemical Hazard | |`;
r = parseActivities(md, CATS);
ok(r.activities.length === 2 && r.activities[0].hazards.length === 2, 'markdown table parsed');
ok(r.activities[0].hazards[0].controls.map((c) => c.text).join('|') === 'Isolate supply|Use gloves', '<br> separated controls');

// ---- no header, number column
r = parseActivities('1\tDemolition\tFalling objects\n2\tExcavation\tInterference', CATS);
ok(r.activities.map((a) => a.title).join() === 'Demolition,Excavation', 'headerless table with number column');

// ---- plain lists
r = parseActivities('Activity: Welding\nHazards: Fire, Electricity\nActivity: Lifting\nHazards: Overhead Crane', CATS);
ok(r.format === 'list' && r.activities.length === 2 && r.activities[0].hazards.length === 2, 'labelled list');
r = parseActivities('1. Concrete cutting\n   - Noise\n   - Dust\n2. Scaffolding\n   - Falling objects', CATS);
ok(r.activities.length === 2 && r.activities[0].hazards.length === 2, 'indented bullets are hazards');
ok(parseActivities('   ', CATS).format === 'empty', 'empty input');

ok(splitItems('1. a b\n   wrapped\n2. c').join('|') === 'a b wrapped|c', 'wrapped numbered item joined');

// ---- validation
const v = validateControls(['1. Inspect the grinder before every use.', 'Inspect the grinder before every use!', 'Same controls as above', 'ok', '**Wear** hearing protection at all times.', '<b>Barricade</b> the work area with tape.'], ['Barricade the work area with tape']);
ok(v.controls.length === 2, `validateControls keeps 2 (got ${v.controls.length}: ${JSON.stringify(v.controls)})`);
ok(v.dropped.some((d) => d.reason === 'refers to other controls'), 'forbidden phrase dropped');
ok(v.dropped.some((d) => d.reason === 'duplicate'), 'duplicate dropped (also vs existing)');
ok(cleanControl('x'.repeat(2000)).length <= 901, 'long control capped');
ok(coverageGaps('Electricity', ['Apply LOTO']).length >= 2, 'coverage gaps flagged for electricity');
ok(coverageGaps('Electricity', ['Client personnel apply LOTO', 'Verify absence of voltage', 'Authorised electrician makes the connections']).length === 0, 'no gaps when covered');

ok(similarity('Wear hearing protection', 'Wear hearing protection!') === 1, 'similarity ignores punctuation');
ok(!isDuplicate('Use a banksman for reversing', ['Inspect the grinder']), 'distinct texts not duplicates');
ok(hazardName({ category: 'Noise', custom_name: 'Noise from breaker' }) === 'Noise from breaker', 'hazardName avoids repetition');
ok(hazardName({ category: 'Fire', custom_name: 'sparks near paint' }) === 'Fire — sparks near paint', 'hazardName combines');

// ---- merge: administrator edits are preserved
const C = (id, text, origin = 'ai', edited = false) => ({ id, text, origin, edited });
const cur = [C('1', 'AI untouched control one here'), C('2', 'AI but edited by admin', 'ai', true), C('3', 'Manual control by admin', 'manual'), C('4', 'AI untouched control four here')];
ok(isProtected(cur[1]) && isProtected(cur[2]) && !isProtected(cur[0]), 'edited / manual controls are protected');
let pl = planGeneration(cur, 'replace_ai', 6);
ok(pl.remove.map((c) => c.id).join() === '1,4' && pl.keep.length === 2 && pl.need === 4, 'replace_ai removes only untouched AI controls');
ok(planGeneration(cur, 'fill', 3).need === 0 && planGeneration(cur, 'fill', 10).need === 6, 'fill tops up to target');
ok(planGeneration(cur, 'add_more', 5).need === 5 && planGeneration(cur, 'add_more', 5).remove.length === 0, 'add_more keeps all');
// admin edits control 4 while generation is running -> it must survive
const during = cur.map((c) => (c.id === '4' ? { ...c, edited: true, text: 'Edited while running' } : c));
let res = applyGeneration(during, pl, 'replace_ai', ['Brand new control about guards', 'Another new control about PPE']);
ok(res.some((c) => c.id === '4') && !res.some((c) => c.id === '1'), 'control edited during generation is not removed');
ok(res.length === 5, 'new controls appended');
res = applyGeneration(res, { keep: [], remove: [], need: 1 }, 'add_more', ['brand new control about guards.']);
ok(res.length === 5, 'retry with the same text adds no duplicate');
res = applyGeneration(cur, planGeneration(cur, 'replace_all', 2), 'replace_all', ['Alpha control text here', 'Beta control text here']);
ok(res.length === 2 && res.every((c) => c.origin === 'ai'), 'replace_all replaces everything');
const rs = replaceSelected(cur, new Set(['1', '4']), ['Replacement for first', 'Replacement for second', 'Extra replacement three']);
ok(rs.length === 5 && rs[0].text === 'Replacement for first' && rs[1].id === '2' && rs[3].text === 'Replacement for second' && rs[4].text === 'Extra replacement three', 'replaceSelected swaps in place');

console.log(failed ? `\n${failed} FAILED` : '\nAll JSA unit tests passed');
process.exit(failed ? 1 : 0);
