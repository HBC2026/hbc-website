export type AccType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type AccSection =
  | 'current_asset' | 'fixed_asset' | 'current_liability' | 'long_term_liability' | 'equity'
  | 'revenue' | 'other_income' | 'cost_of_sales' | 'operating_expense' | 'other_expense';

export interface Acc { id: string; code: string; name: string; type: AccType; section: AccSection; is_active: boolean }
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

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Assets and expenses grow with debits; liabilities, equity and income grow with credits. */
export const isDebitNature = (t: AccType) => t === 'asset' || t === 'expense';
export const natural = (t: AccType, debit: number, credit: number) => r2(isDebitNature(t) ? debit - credit : credit - debit);

export interface ReportRow {
  kind: 'section' | 'line' | 'total' | 'grand';
  label: string;
  amount?: number;
  code?: string;
}

function balanceMap(bals: Bal[]) {
  return new Map(bals.map((b) => [b.account_id, b]));
}

/** Accounts of one section with a non-zero balance, as report lines. */
function sectionLines(accs: Acc[], bm: Map<string, Bal>, section: AccSection) {
  const lines = accs
    .filter((a) => a.section === section)
    .map((a) => ({ a, v: natural(a.type, bm.get(a.id)?.debit ?? 0, bm.get(a.id)?.credit ?? 0) }))
    .filter((x) => x.v !== 0)
    .sort((x, y) => x.a.code.localeCompare(y.a.code));
  return { lines, total: r2(lines.reduce((s, x) => s + x.v, 0)) };
}

function emit(rows: ReportRow[], title: string, totalLabel: string, accs: Acc[], bm: Map<string, Bal>, section: AccSection) {
  const { lines, total } = sectionLines(accs, bm, section);
  rows.push({ kind: 'section', label: title });
  lines.forEach(({ a, v }) => rows.push({ kind: 'line', label: a.name, code: a.code, amount: v }));
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
  lines.forEach(({ a, v }) => rows.push({ kind: 'line', label: a.name, code: a.code, amount: v }));
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
  ws.columns = [{ width: 12 }, { width: 46 }, { width: 18 }];
  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([subtitle]);
  ws.addRow([]);
  for (const r of rows) {
    const row = ws.addRow([r.code ?? '', r.label, r.amount ?? null]);
    row.getCell(3).numFmt = '#,##0.00;[Red](#,##0.00)';
    if (r.kind === 'section') row.font = { bold: true, color: { argb: 'FF1F3A5F' } };
    if (r.kind === 'total') { row.font = { bold: true }; row.getCell(3).border = { top: { style: 'thin' } }; }
    if (r.kind === 'grand') {
      row.font = { bold: true };
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F7' } }; });
      row.getCell(3).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${file}.xlsx`; a.click();
  URL.revokeObjectURL(url);
}
