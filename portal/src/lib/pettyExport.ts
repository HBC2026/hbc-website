import type { PcCash, PcReceipt } from './types';

interface Emp { id: string; emp_code: string; name: string }
type CashRow = PcCash & { employee_id: string };
type RecRow = PcReceipt & { employee_id: string };

const NUM = '#,##0.00;[Red]-#,##0.00';
const HEAD = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F3A5F' } };

/** Excel sheet names: max 31 chars, no : \ / ? * [ ], unique. */
function sheetName(raw: string, used: Set<string>) {
  const base = raw.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || 'Employee';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28 - String(i).length - 1)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

function styleHeader(row: import('exceljs').Row) {
  row.eachCell((c) => { c.fill = HEAD; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { vertical: 'middle' }; });
}

/** Builds and downloads a workbook: a "Total" sheet plus one ledger sheet per employee. */
export async function exportPettyCash(emps: Emp[], cash: CashRow[], receipts: RecRow[], company: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>(['total']);

  const total = wb.addWorksheet('Total');
  total.addRow([`${company} — Petty Cash Register`]).font = { bold: true, size: 14 };
  total.addRow([`Exported ${new Date().toLocaleDateString('en-GB')}`]);
  total.addRow([]);
  styleHeader(total.addRow(['ID', 'Employee', 'Cash given', 'Receipts (pending + approved)', 'Balance held', 'Pending', 'Rejected']));
  const first = total.rowCount + 1;

  const sum = { given: 0, spent: 0, pend: 0, rej: 0 };
  const sheets: { emp: Emp; name: string }[] = emps.map((emp) => ({ emp, name: sheetName(`${emp.emp_code} ${emp.name}`, used) }));

  for (const { emp, name } of sheets) {
    const c = cash.filter((x) => x.employee_id === emp.id);
    const r = receipts.filter((x) => x.employee_id === emp.id);
    const ws = wb.addWorksheet(name);
    ws.addRow([`${emp.name} (${emp.emp_code})`]).font = { bold: true, size: 14 };
    ws.addRow([]);
    styleHeader(ws.addRow(['Date', 'Type', 'Description / note', 'Given by', 'Status', 'Cash given', 'Receipt amount', 'Balance']));
    const events = [
      ...c.map((x) => ({ date: x.given_on, at: x.created_at, type: 'Cash given', text: x.note, by: x.given_by, status: '', inn: Number(x.amount), out: 0 })),
      ...r.map((x) => ({ date: x.spent_on, at: x.created_at, type: 'Receipt', text: x.description, by: '', status: x.status[0].toUpperCase() + x.status.slice(1), inn: 0, out: x.status === 'rejected' ? 0 : Number(x.amount), raw: Number(x.amount) })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
    const start = ws.rowCount + 1;
    let run = 0;
    events.forEach((e) => {
      const row = ws.addRow([e.date, e.type, e.text, e.by, e.status, e.inn || null, 'raw' in e ? e.raw : null, null]);
      run += e.inn - e.out;
      row.getCell(8).value = { formula: `SUM($F$${start}:F${row.number})-SUMIF($E$${start}:E${row.number},"<>Rejected",$G$${start}:G${row.number})`, result: run };
      if (e.status === 'Rejected') row.font = { color: { argb: 'FF999999' }, italic: true };
    });
    // totals ignore rejected receipts (they do not reduce the balance)
    const end = start + events.length - 1;
    const given = c.reduce((a, x) => a + Number(x.amount), 0);
    const spent = r.filter((x) => x.status !== 'rejected').reduce((a, x) => a + Number(x.amount), 0);
    const tr = ws.addRow(['Total', '', '', '', '', null, null, null]);
    if (events.length) {
      tr.getCell(6).value = { formula: `SUM(F${start}:F${end})`, result: given };
      tr.getCell(7).value = { formula: `SUMIF(E${start}:E${end},"<>Rejected",G${start}:G${end})`, result: spent };
    } else { tr.getCell(6).value = 0; tr.getCell(7).value = 0; }
    tr.getCell(8).value = { formula: `F${tr.number}-G${tr.number}`, result: given - spent };
    tr.font = { bold: true };
    ws.getColumn(1).width = 13; ws.getColumn(2).width = 12; ws.getColumn(3).width = 38; ws.getColumn(4).width = 18; ws.getColumn(5).width = 12;
    [6, 7, 8].forEach((n) => { ws.getColumn(n).width = 16; ws.getColumn(n).numFmt = NUM; });
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const q = `'${name.replace(/'/g, "''")}'`;
    sum.given += given; sum.spent += spent; sum.pend += r.filter((x) => x.status === 'pending').length; sum.rej += r.filter((x) => x.status === 'rejected').length;
    total.addRow([
      emp.emp_code, { text: emp.name, hyperlink: `#${q}!A1` } as never,
      { formula: `${q}!F${tr.number}`, result: given }, { formula: `${q}!G${tr.number}`, result: spent },
      { formula: `${q}!H${tr.number}`, result: given - spent },
      r.filter((x) => x.status === 'pending').length, r.filter((x) => x.status === 'rejected').length,
    ]);
  }

  const last = total.rowCount;
  const gt = total.addRow(['', 'Grand total', null, null, null, null, null]);
  if (sheets.length) {
    const res = [sum.given, sum.spent, sum.given - sum.spent, sum.pend, sum.rej];
    (['C', 'D', 'E', 'F', 'G'] as const).forEach((col, i) => { gt.getCell(3 + i).value = { formula: `SUM(${col}${first}:${col}${last})`, result: res[i] }; });
  }
  gt.font = { bold: true };
  gt.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
  total.getColumn(1).width = 12; total.getColumn(2).width = 30;
  [3, 4, 5].forEach((n) => { total.getColumn(n).width = 18; total.getColumn(n).numFmt = NUM; });
  total.getColumn(6).width = 10; total.getColumn(7).width = 10;
  total.views = [{ state: 'frozen', ySplit: 4 }];
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `Petty-Cash-Register-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
