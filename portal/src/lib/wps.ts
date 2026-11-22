import type { Employee, PayrollEntry } from './types';

export type WpsEntry = PayrollEntry & { employees: Employee };

/**
 * Column layout of the WPS / Mudad salary file. Kept in one place so it can be adjusted
 * if Mudad's template changes. One row per employee, comma separated, UTF-8, saved as .txt.
 */
export const WPS_COLUMNS = [
  'Employee Name', 'Employee ID (Iqama)', 'Bank Code', 'IBAN',
  'Basic Salary', 'Housing Allowance', 'Other Earnings', 'Deductions', 'Net Salary',
] as const;

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const text = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const cleanIban = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export interface WpsProblem { emp_code: string; name: string; problem: string }

/** Anything that would make Mudad reject the row. */
export function wpsProblems(entries: WpsEntry[]): WpsProblem[] {
  const out: WpsProblem[] = [];
  for (const en of entries) {
    const e = en.employees;
    const add = (problem: string) => out.push({ emp_code: e.emp_code, name: e.name, problem });
    if (!/^\d{10}$/.test((e.iqama_no ?? '').trim())) add('Iqama / ID number missing or not 10 digits');
    if (!(e.bank_code ?? '').trim()) add('Bank code missing');
    if (!/^SA\d{22}$/.test(cleanIban(e.iban ?? ''))) add('IBAN missing or not a valid Saudi IBAN (SA + 22 digits)');
    if (Number(en.net_salary) <= 0) add('Net salary is zero or negative');
  }
  return out;
}

/**
 * Builds the file contents. Housing is not tracked separately, so allowances, overtime and other earnings are
 * reported as "Other Earnings". Deductions include any amount already paid, so the columns add up to the net salary.
 */
export function buildWpsFile(entries: WpsEntry[]): string {
  const rows = entries.map((en) => {
    const e = en.employees;
    const other = Number(en.allowances) + Number(en.ot_amount) + Number(en.other_earnings);
    const ded = Number(en.deductions) + Number(en.advance_paid ?? 0);
    return [
      text(e.name.trim()), e.iqama_no.trim(), e.bank_code.trim().toUpperCase(), cleanIban(e.iban),
      money(Number(en.basic)), money(0), money(other), money(ded), money(Number(en.net_salary)),
    ].join(',');
  });
  return [WPS_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

export function downloadWps(entries: WpsEntry[], ym: string) {
  const blob = new Blob([buildWpsFile(entries)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `WPS-${ym}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
