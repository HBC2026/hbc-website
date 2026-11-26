export type AccType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type AccSection =
  | 'current_asset' | 'fixed_asset' | 'current_liability' | 'long_term_liability' | 'equity'
  | 'revenue' | 'other_income' | 'cost_of_sales' | 'operating_expense' | 'other_expense';

export type AccKind = '' | 'cash' | 'receivable' | 'payable';
export interface Acc { id: string; name: string; type: AccType; section: AccSection; kind: AccKind; sort_order: number | null; is_active: boolean }
export interface Bal { account_id: string; debit: number; credit: number }
export interface JournalLine { id: string; entry_id: string; account_id: string; debit: number; credit: number; memo: string }
export interface JournalEntry { id: string; entry_no: number; entry_date: string; memo: string; reference: string; created_at: string }

export const TYPE_LABEL: Record<AccType, string> = {
  asset: 'Asset', liability: 'Liability', equity: 'Equity', income: 'Income', expense: 'Expense',
};
export const TYPES = Object.keys(TYPE_LABEL) as AccType[];

export const SECTION_LABEL: Record<AccSection, string> = {
  current_asset: 'Current assets', fixed_asset: 'Fixed assets',
  current_liability: 'Current liabilities', long_term_liability: 'Long-term liabilities', equity: 'Equity',
  revenue: 'Revenue', other_income: 'Other income',
  cost_of_sales: 'Cost of sales', operating_expense: 'Operating expenses', other_expense: 'Other expenses',
};
export const SECTIONS_OF: Record<AccType, AccSection[]> = {
  asset: ['current_asset', 'fixed_asset'],
  liability: ['current_liability', 'long_term_liability'],
  equity: ['equity'],
  income: ['revenue', 'other_income'],
  expense: ['cost_of_sales', 'operating_expense', 'other_expense'],
};

const SECTION_ORDER = Object.keys(SECTION_LABEL) as AccSection[];
const last = Number.MAX_SAFE_INTEGER;

/** By section (statement order), then the user's own order, then name. */
export function sortAccounts<T extends Pick<Acc, 'name' | 'section' | 'sort_order'>>(accs: T[]): T[] {
  return [...accs].sort((a, b) =>
    SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
    || (a.sort_order ?? last) - (b.sort_order ?? last)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export const r2 =(n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Assets and expenses grow with debits; liabilities, equity and income grow with credits. */
export const isDebitNature = (t: AccType) => t === 'asset' || t === 'expense';
export const natural = (t: AccType, debit: number, credit: number) => r2(isDebitNature(t) ? debit - credit : credit - debit);

export interface ReportRow {
  kind: 'section' | 'line' | 'total' | 'grand';
  label: string;
  amount?: number;
}

function balanceMap(bals: Bal[]) {
  return new Map(bals.map((b) => [b.account_id, b]));
}

/** Accounts of one section with a non-zero balance, as report lines. */
function sectionLines(accs: Acc[], bm: Map<string, Bal>, section: AccSection) {
  const lines = sortAccounts(accs.filter((a) => a.section === section))
    .map((a) => ({ a, v: natural(a.type, bm.get(a.id)?.debit ?? 0, bm.get(a.id)?.credit ?? 0) }))
    .filter((x) => x.v !== 0);
  return { lines, total: r2(lines.reduce((s, x) => s + x.v, 0)) };
}

function emit(rows: ReportRow[], title: string, totalLabel: string, accs: Acc[], bm: Map<string, Bal>, section: AccSection) {
  const { lines, total } = sectionLines(accs, bm, section);
  rows.push({ kind: 'section', label: title });
  lines.forEach(({ a, v }) => rows.push({ kind: 'line', label: a.name, amount: v }));
  rows.push({ kind: 'total', label: totalLabel, amount: total });
  return total;
}

export interface Pnl { rows: ReportRow[]; revenue: number; grossProfit: number; operatingProfit: number; netProfit: number; expenses: number }

/** Profit & Loss from the balances of entries dated inside the period. */
export function buildPnl(accs: Acc[], bals: Bal[]): Pnl {
  const bm = balanceMap(bals);
  const rows: ReportRow[] = [];
  const revenue = emit(rows, 'Revenue', 'Total revenue', accs, bm, 'revenue');
  const cos = emit(rows, 'Cost of sales', 'Total cost of sales', accs, bm, 'cost_of_sales');
  const grossProfit = r2(revenue - cos);
  rows.push({ kind: 'grand', label: 'Gross profit', amount: grossProfit });
  const opex = emit(rows, 'Operating expenses', 'Total operating expenses', accs, bm, 'operating_expense');
  const operatingProfit = r2(grossProfit - opex);
  rows.push({ kind: 'grand', label: 'Operating profit', amount: operatingProfit });
  const otherInc = emit(rows, 'Other income', 'Total other income', accs, bm, 'other_income');
  const otherExp = emit(rows, 'Other expenses', 'Total other expenses', accs, bm, 'other_expense');
  const netProfit = r2(operatingProfit + otherInc - otherExp);
  rows.push({ kind: 'grand', label: 'Net profit / (loss)', amount: netProfit });
  return { rows, revenue: r2(revenue + otherInc), grossProfit, operatingProfit, netProfit, expenses: r2(cos + opex + otherExp) };
}

export interface BalanceSheet { rows: ReportRow[]; assets: number; liabilities: number; equity: number; difference: number }

/** Balance Sheet from every entry up to the "as at" date. Profit that has not been closed to equity is shown as one line. */
export function buildBalanceSheet(accs: Acc[], bals: Bal[]): BalanceSheet {
  const bm = balanceMap(bals);
  const rows: ReportRow[] = [];

  rows.push({ kind: 'section', label: 'ASSETS' });
  const ca = emit(rows, 'Current assets', 'Total current assets', accs, bm, 'current_asset');
  const fa = emit(rows, 'Fixed assets', 'Total fixed assets', accs, bm, 'fixed_asset');
  const assets = r2(ca + fa);
  rows.push({ kind: 'grand', label: 'TOTAL ASSETS', amount: assets });

  rows.push({ kind: 'section', label: 'LIABILITIES' });
  const cl = emit(rows, 'Current liabilities', 'Total current liabilities', accs, bm, 'current_liability');
  const ll = emit(rows, 'Long-term liabilities', 'Total long-term liabilities', accs, bm, 'long_term_liability');
  const liabilities = r2(cl + ll);
  rows.push({ kind: 'grand', label: 'TOTAL LIABILITIES', amount: liabilities });

  rows.push({ kind: 'section', label: 'EQUITY' });
  const { lines, total: eq } = sectionLines(accs, bm, 'equity');
  lines.forEach(({ a, v }) => rows.push({ kind: 'line', label: a.name, amount: v }));
  const earned = r2(accs.reduce((s, a) => {
    if (a.type !== 'income' && a.type !== 'expense') return s;
    const b = bm.get(a.id);
    return s + (a.type === 'income' ? 1 : -1) * natural(a.type, b?.debit ?? 0, b?.credit ?? 0);
  }, 0));
  if (earned !== 0) rows.push({ kind: 'line', label: 'Profit / (loss) not yet closed to equity', amount: earned });
  const equity = r2(eq + earned);
  rows.push({ kind: 'grand', label: 'TOTAL EQUITY', amount: equity });
  rows.push({ kind: 'grand', label: 'TOTAL LIABILITIES + EQUITY', amount: r2(liabilities + equity) });

  return { rows, assets, liabilities, equity, difference: r2(assets - liabilities - equity) };
}

/** Builds and downloads an Excel copy of a report. */
export async function exportReportXlsx(file: string, company: string, title: string, subtitle: string, rows: ReportRow[]) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.columns = [{ width: 52 }, { width: 18 }];
  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([subtitle]);
  ws.addRow([]);
  for (const r of rows) {
    const row = ws.addRow([r.label, r.amount ?? null]);
    row.getCell(2).numFmt = '#,##0.00;[Red](#,##0.00)';
    if (r.kind === 'section') row.font = { bold: true, color: { argb: 'FF1F3A5F' } };
    if (r.kind === 'total') { row.font = { bold: true }; row.getCell(2).border = { top: { style: 'thin' } }; }
    if (r.kind === 'grand') {
      row.font = { bold: true };
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F7' } }; });
      row.getCell(2).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${file}.xlsx`; a.click();
  URL.revokeObjectURL(url);
}

export interface Vendor { id: string; name: string; phone: string; vat_no: string; notes: string; is_active: boolean }
export interface VendorPayment {
  id: string; entry_no: number; entry_date: string; memo: string; reference: string; vendor_id: string; doc_id: string | null;
  acc_lines: { account_id: string; debit: number; credit: number }[];
}

export const paymentAmount = (p: VendorPayment) => r2(p.acc_lines.reduce((s, l) => s + Number(l.debit), 0));

/* ------------------------------------------------ invoices and bills */

export type DocKind = 'invoice' | 'bill';

/** One row of acc_doc_list: an invoice or bill and what has been paid against it. */
export interface AccDoc {
  id: string; doc_no: number; doc_date: string; due_date: string; party_id: string;
  control_account_id: string; vat_account_id: string | null; vat_rate: number;
  subtotal: number; vat: number; total: number; paid: number; reference: string; memo: string;
}

export const docNo = (kind: DocKind, n: number) => `${kind === 'invoice' ? 'INV' : 'BILL'}-${String(n).padStart(4, '0')}`;

/** Same rounding as acc_save_doc: each line to the halala, then VAT on the subtotal. Worked in whole numbers. */
export function docTotals(lines: { qty: number | string; unit_price: number | string }[], rate: number) {
  const cents = lines.reduce((s, l) => s + Math.round(Math.round(Number(l.qty) * 1000) * Math.round(Number(l.unit_price) * 100) / 1000), 0);
  const vat = Math.round(cents * Math.round(rate * 10000) / 10000);
  return { subtotal: cents / 100, vat: vat / 100, total: (cents + vat) / 100 };
}

export const docBalance = (d: Pick<AccDoc, 'total' | 'paid'>) => r2(d.total - d.paid);

export type DocStatus = 'paid' | 'overdue' | 'partial' | 'open';
export function docStatus(d: Pick<AccDoc, 'total' | 'paid' | 'due_date'>, asAt: string): DocStatus {
  if (docBalance(d) <= 0) return 'paid';
  if (d.due_date < asAt) return 'overdue';
  return d.paid > 0 ? 'partial' : 'open';
}

export const AGE_LABELS = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'];

export interface AgingRow { party_id: string; buckets: number[]; total: number }

/** What is still owed per client or vendor, split by how many days past the due date it is. */
export function aging(docs: Pick<AccDoc, 'party_id' | 'due_date' | 'total' | 'paid'>[], asAt: string) {
  const zero = () => AGE_LABELS.map(() => 0);
  const byParty = new Map<string, AgingRow>();
  const buckets = zero();
  let total = 0;
  for (const d of docs) {
    const owed = docBalance(d);
    if (owed <= 0) continue;
    const days = Math.round((Date.parse(asAt) - Date.parse(d.due_date)) / 86_400_000);
    const i = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
    const row = byParty.get(d.party_id) ?? { party_id: d.party_id, buckets: zero(), total: 0 };
    byParty.set(d.party_id, row);
    row.buckets[i] = r2(row.buckets[i] + owed);
    row.total = r2(row.total + owed);
    buckets[i] = r2(buckets[i] + owed);
    total = r2(total + owed);
  }
  return { rows: [...byParty.values()].sort((a, b) => b.total - a.total), buckets, total };
}
