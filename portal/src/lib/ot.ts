import { daysInMonth } from './format';
import type { Employee, Settings } from './types';

/**
 * Overtime hourly rate for an employee in the month of `date` (YYYY-MM-DD).
 * Mirrors ot_hourly_rate() in the database (migration 0031):
 *   (basic + allowances) ÷ calendar days in the month ÷ OT day hours (9) × multiplier (1.5)
 * A "fixed" employee uses their fixed SAR-per-hour rate instead.
 */
export function otHourlyRate(e: Pick<Employee, 'basic_salary' | 'allowances' | 'ot_method' | 'ot_rate'>, date: string, s: Pick<Settings, 'ot_multiplier' | 'ot_day_hours'>): number {
  if (e.ot_method === 'fixed') return Number(e.ot_rate ?? 0);
  const [y, m] = date.split('-').map(Number);
  const mult = e.ot_rate == null ? s.ot_multiplier : Number(e.ot_rate);
  const monthly = Number(e.basic_salary) + Number(e.allowances);
  return Math.round((monthly / daysInMonth(y, m) / s.ot_day_hours) * mult * 100) / 100;
}

/** The steps behind the rate, for showing the working on screen. */
export function otRateWorking(e: Pick<Employee, 'basic_salary' | 'allowances' | 'ot_method' | 'ot_rate'>, date: string, s: Pick<Settings, 'ot_multiplier' | 'ot_day_hours'>) {
  const [y, m] = date.split('-').map(Number);
  const days = daysInMonth(y, m);
  const monthly = Number(e.basic_salary) + Number(e.allowances);
  const daily = monthly / days;
  const hourly = daily / s.ot_day_hours;
  const mult = e.ot_rate == null ? s.ot_multiplier : Number(e.ot_rate);
  return { monthly, days, daily, hourly, mult, rate: otHourlyRate(e, date, s) };
}
