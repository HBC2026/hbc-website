export type Role = 'administrator' | 'payroll' | 'attendance' | 'quotations' | 'viewer';

export type AttendanceStatus =
  | 'present' | 'absent' | 'annual_leave' | 'sick_leave' | 'unpaid_leave' | 'holiday' | 'weekly_off';

export interface Company { id: string; code: string; name: string; name_ar: string }

export interface Profile { id: string; full_name: string; email: string | null; role: Role; created_at: string }

export interface Employee {
  id: string; emp_code: string; name: string; job_title: string; department: string;
  joining_date: string; basic_salary: number; allowances: number;
  ot_method: 'multiplier' | 'fixed'; ot_rate: number | null; status: 'active' | 'inactive';
}

export interface AttendanceRow {
  id: string; employee_id: string; work_date: string; status: AttendanceStatus;
  regular_hours: number; ot_hours: number; ot_amount?: number; ot_paid?: boolean; remarks: string;
}

export type PeriodStatus = 'open' | 'calculated' | 'approved' | 'completed';
export interface PayrollPeriod {
  id: string; year: number; month: number; status: PeriodStatus; calculated_at: string | null;
  approved_by: string | null; approved_at: string | null; reopen_reason: string | null; completed_at: string | null;
  start_date?: string | null; end_date?: string | null; employee_ids?: string[] | null;
}

export interface PayrollEntry {
  id: string; period_id: string; employee_id: string; basic: number; allowances: number;
  present_days: number; unpaid_days: number; regular_hours: number; ot_hours: number; ot_rate: number;
  ot_amount: number; ot_paid_amount?: number; other_earnings: number; absence_deduction: number; other_deductions: number;
  deductions: number; net_salary: number; adjustment_note: string;
  breakdown: {
    ot_paid_amount?: number; hourly_rate: number; daily_rate: number; ot_method: string; ot_multiplier: number;
    days_divisor: number; standard_hours: number; counts: Record<AttendanceStatus, number>;
  };
  employees?: Employee;
}

export type SlipStatus = 'generated' | 'awaiting_signature' | 'signed_uploaded' | 'completed';
export interface SalarySlip {
  id: string; entry_id: string; period_id: string; employee_id: string; slip_no: string;
  net_snapshot: number; status: SlipStatus; printed_at: string | null; signed_path: string | null;
  signed_uploaded_at: string | null;
  employees?: Employee; payroll_periods?: PayrollPeriod;
}

export type QuotationStatus = 'draft' | 'submitted' | 'revised' | 'approved' | 'rejected' | 'expired';
export interface Quotation {
  id: string; number: string; current_revision: number; status: QuotationStatus; client: string;
  project: string; quote_date: string; amount: number; created_at: string;
}
export interface Client {
  id: string; name: string; attention: string; email: string; phone: string; address: string;
  vat_no: string; payment_terms: string; notes: string; status: 'active' | 'inactive';
}
export interface QuotationItem { id?: string; position?: number; description: string; qty: number; unit: string; unit_price: number }
export interface QuotationRevision {
  id: string; quotation_id: string; revision: number; client: string; attention: string; project: string;
  quote_date: string; validity_days: number; reference: string; subtotal: number; discount: number;
  vat_rate: number; vat_amount: number; grand_total: number; payment_terms: string; delivery: string;
  notes: string; revision_note: string; created_at: string;
  quotation_items?: QuotationItem[];
}

export interface AuditLog {
  id: number; user_name: string; action: string; record_type: string; record_id: string | null;
  record_label: string | null; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null;
  created_at: string;
}

export interface Settings {
  ot_multiplier: number; standard_hours: number; days_divisor: number; vat_rate: number; max_ot_per_day: number;
  company: { name: string; name_ar: string; address: string; phone: string; email: string; vat_no: string; cr_no: string; logo?: string };
}

export type ReceiptStatus = 'pending' | 'approved' | 'rejected';
export interface PcSummaryRow {
  employee_id: string; given: number; spent: number; pending_count: number; rejected_count: number; balance: number; has_link: boolean;
}
export interface PcCash { id: string; amount: number; given_on: string; note: string; given_by: string; created_at: string }
export interface PcReceipt {
  id: string; amount: number; spent_on: string; description: string; file_path: string;
  status: ReceiptStatus; reject_reason: string; created_at: string;
}
/** What the employee's private page receives from pc_statement(token). */
export interface PcStatement {
  name: string; emp_code: string; company: string; active: boolean;
  given: number; spent: number; balance: number;
  cash: { id: string; amount: number; date: string; note: string; given_by: string }[];
  receipts: { id: string; amount: number; date: string; description: string; status: ReceiptStatus; reject_reason: string }[];
}
