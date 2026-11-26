// Invoice / bill totals, status and aging.
//   node --experimental-strip-types tests/invoices.test.mjs
import { aging, docBalance, docNo, docStatus, docTotals } from '../src/lib/accounting.ts';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n}${JSON.stringify(a) === JSON.stringify(b) ? '' : ' — got ' + JSON.stringify(a)}`);

// totals must round the way the database does
eq(docTotals([{ qty: 2, unit_price: 500 }, { qty: 3, unit_price: 33.33 }], 0.15), { subtotal: 1099.99, vat: 165, total: 1264.99 }, 'subtotal, VAT and total');
eq(docTotals([{ qty: 1.5, unit_price: 0.67 }], 0), { subtotal: 1.01, vat: 0, total: 1.01 }, 'a half halala rounds up (1.005)');
eq(docTotals([{ qty: '', unit_price: '10' }, { qty: '2', unit_price: '' }], 0.15), { subtotal: 0, vat: 0, total: 0 }, 'blank inputs count as zero');

eq([docNo('invoice', 7), docNo('bill', 12)], ['INV-0007', 'BILL-0012'], 'document numbers');

const doc = (o) => ({ party_id: 'a', doc_date: '2026-01-01', due_date: '2026-03-31', total: 100, paid: 0, ...o });
eq(docBalance(doc({ total: 0.3, paid: 0.1 })), 0.2, 'balance has no float dust');
eq([
  docStatus(doc({ paid: 100 }), '2026-06-01'),
  docStatus(doc({}), '2026-04-01'),
  docStatus(doc({ paid: 40 }), '2026-04-01'),
  docStatus(doc({ paid: 40 }), '2026-03-31'),
  docStatus(doc({}), '2026-03-31'),
], ['paid', 'overdue', 'overdue', 'partial', 'open'], 'status: paid, overdue only after the due date, partly paid, open');

// as at 30 June 2026: 0 days = not due, then 1–30, 31–60, 61–90, over 90
const due = (due_date, total, extra = {}) => doc({ due_date, total, ...extra });
const report = aging([
  due('2026-06-30', 1), due('2026-06-29', 2), due('2026-05-31', 4), due('2026-05-30', 8),
  due('2026-05-01', 16), due('2026-04-30', 32), due('2026-04-01', 64), due('2026-03-31', 128),
  due('2026-03-31', 500, { party_id: 'b', paid: 100 }),
  due('2026-03-31', 999, { party_id: 'c', paid: 999 }),
], '2026-06-30');
eq(report.rows.map((r) => r.party_id), ['b', 'a'], 'largest balance first, settled parties left out');
eq(report.rows[1].buckets, [1, 6, 24, 96, 128], 'each age lands in its bucket');
eq([report.rows[1].total, report.total, report.buckets], [255, 655, [1, 6, 24, 96, 528]], 'row and report totals');

console.log(failed ? `\n${failed} FAILED` : '\nAll invoice logic tests passed');
process.exit(failed ? 1 : 0);
