// Chart of accounts ordering and reports, without account codes.
//   node --experimental-strip-types tests/accounting.test.mjs
import { buildPnl, sortAccounts } from '../src/lib/accounting.ts';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const a = (name, section, sort_order = null, type = 'expense') => ({ id: name, name, section, sort_order, type, kind: '', is_active: true });
const names = (list) => sortAccounts(list).map((x) => x.name).join(',');

ok(names([a('Rent', 'operating_expense'), a('Bank', 'current_asset'), a('Fuel', 'cost_of_sales')]) === 'Bank,Fuel,Rent', 'grouped by section in statement order');
ok(names([a('Utilities', 'operating_expense'), a('insurance', 'operating_expense'), a('Rent', 'operating_expense')]) === 'insurance,Rent,Utilities', 'by name inside a section, ignoring case');
ok(names([a('A', 'operating_expense', 2), a('Z', 'operating_expense', 1)]) === 'Z,A', 'the saved order wins over the name');
ok(names([a('B new', 'operating_expense'), a('Z', 'operating_expense', 1), a('A new', 'operating_expense')]) === 'Z,A new,B new', 'accounts added after arranging go last, by name');

const input = [a('Rent', 'operating_expense', 2), a('Travel', 'operating_expense', 1)];
const rows = buildPnl(input, [{ account_id: 'Rent', debit: 5, credit: 0 }, { account_id: 'Travel', debit: 7, credit: 0 }]).rows;
ok(rows.filter((r) => r.kind === 'line').map((r) => r.label).join(',') === 'Travel,Rent', 'reports follow the same order');
ok(input[0].name === 'Rent', 'sorting does not change the list passed in');

console.log(failed ? `\n${failed} FAILED` : '\nAll chart of accounts tests passed');
process.exit(failed ? 1 : 0);
