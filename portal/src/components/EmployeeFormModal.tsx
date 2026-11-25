'use client';
import { useState } from 'react';
import { Riyal } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { DatePicker, Field, Modal, Select } from '@/components/ui';
import { today } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import type { Employee } from '@/lib/types';

type Draft = Omit<Employee, 'id' | 'basic_salary' | 'allowances' | 'ot_rate' | 'iqama_issue_date' | 'iqama_expiry_date' | 'work_permit_expiry_date' | 'tamin_expiry_date'> & {
  id?: string; basic_salary: string; allowances: string; ot_rate: string; iqama_issue_date: string; iqama_expiry_date: string;
  work_permit_expiry_date: string; tamin_expiry_date: string;
};

function toDraft(e?: Employee, nextCode = ''): Draft {
  return {
    id: e?.id, emp_code: e?.emp_code ?? nextCode, name: e?.name ?? '', job_title: e?.job_title ?? '', department: e?.department ?? '',
    joining_date: e?.joining_date ?? today(), basic_salary: String(e?.basic_salary ?? ''), allowances: String(e?.allowances ?? 0),
    ot_method: e?.ot_method ?? 'multiplier', ot_rate: e?.ot_rate == null ? '' : String(e.ot_rate), status: e?.status ?? 'active',
    iqama_no: e?.iqama_no ?? '', iqama_issue_date: e?.iqama_issue_date ?? '', iqama_expiry_date: e?.iqama_expiry_date ?? '',
    work_permit_expiry_date: e?.work_permit_expiry_date ?? '', tamin_expiry_date: e?.tamin_expiry_date ?? '',
    bank_code: e?.bank_code ?? '', iban: e?.iban ?? '', last_working_date: e?.last_working_date ?? null,
  };
}

/** Add / edit employee form. Pass `employee` to edit, omit it (with `nextCode`) to add. */
export function EmployeeFormModal({ employee, nextCode = '', onClose, onSaved }: {
  employee?: Employee; nextCode?: string; onClose: () => void; onSaved: () => void;
}) {
  const { settings, toast } = useApp();
  const sb = supabase();
  const [draft, setDraft] = useState<Draft>(() => toDraft(employee, nextCode));
  const [saving, setSaving] = useState(false);
  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  async function save() {
    if (!draft.name.trim() || !draft.emp_code.trim()) return toast('Employee ID and name are required', true);
    if (Number(draft.basic_salary) <= 0) return toast('Basic salary must be greater than zero', true);
    if (draft.ot_method === 'fixed' && draft.ot_rate === '') return toast('Enter the fixed OT rate per hour', true);
    if (draft.iqama_no.trim() && !/^\d{10}$/.test(draft.iqama_no.trim())) return toast('Iqama number must be 10 digits', true);
    if (draft.iqama_issue_date && draft.iqama_expiry_date && draft.iqama_expiry_date <= draft.iqama_issue_date) return toast('Iqama expiry date must be after the issue date', true);
    const iban = draft.iban.replace(/\s+/g, '').toUpperCase();
    if (iban && !/^SA\d{22}$/.test(iban)) return toast('IBAN must be SA followed by 22 digits', true);
    setSaving(true);
    const payload = {
      iqama_no: draft.iqama_no.trim(), iqama_issue_date: draft.iqama_issue_date || null, iqama_expiry_date: draft.iqama_expiry_date || null,
      work_permit_expiry_date: draft.work_permit_expiry_date || null, tamin_expiry_date: draft.tamin_expiry_date || null,
      bank_code: draft.bank_code.trim().toUpperCase(), iban,
      emp_code: draft.emp_code.trim(), name: draft.name.trim(), job_title: draft.job_title.trim(), department: draft.department.trim(),
      joining_date: draft.joining_date, basic_salary: Number(draft.basic_salary), allowances: Number(draft.allowances || 0),
      ot_method: draft.ot_method, ot_rate: draft.ot_rate === '' ? null : Number(draft.ot_rate), status: draft.status,
      last_working_date: draft.status === 'inactive' ? draft.last_working_date || null : null,
    };
    const res = draft.id ? await sb.from('employees').update(payload).eq('id', draft.id) : await sb.from('employees').insert(payload);
    setSaving(false);
    if (res.error) return toast(res.error.message, true);
    toast(draft.id ? 'Employee updated' : 'Employee added');
    onSaved();
  }

  return (
    <Modal title={draft.id ? 'Edit Employee' : 'Add Employee'} wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Employee'}</button></>}>
      <div className="form-section">
        <div className="form-section-title">Employee</div>
        <div className="form-grid">
          <Field label="Employee ID"><input className="input" value={draft.emp_code} onChange={(e) => set('emp_code', e.target.value)} /></Field>
          <Field label="Full name" className="span-2"><input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Job title"><input className="input" value={draft.job_title} onChange={(e) => set('job_title', e.target.value)} /></Field>
          <Field label="Department"><input className="input" value={draft.department} onChange={(e) => set('department', e.target.value)} /></Field>
          <Field label="Joining date"><DatePicker value={draft.joining_date} onChange={(v) => set('joining_date', v)} /></Field>
          {draft.status === 'inactive' && <Field label="Last working day"><DatePicker value={draft.last_working_date ?? ''} onChange={(v) => set('last_working_date', v)} /></Field>}
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Salary &amp; overtime</div>
        <div className="form-grid cols-4">
          <Field label={<>Basic salary (<Riyal /> / mo)</>}><input className="input num" type="number" min="0" step="0.01" value={draft.basic_salary} onChange={(e) => set('basic_salary', e.target.value)} /></Field>
          <Field label={<>Allowances (<Riyal /> / mo)</>}><input className="input num" type="number" min="0" step="0.01" value={draft.allowances} onChange={(e) => set('allowances', e.target.value)} /></Field>
          <Field label="OT calculation">
            <Select className="select" value={draft.ot_method} onChange={(e) => set('ot_method', e.target.value)}>
              <option value="multiplier">Multiplier on hourly rate</option>
              <option value="fixed">Fixed rate per hour</option>
            </Select>
          </Field>
          <Field label={draft.ot_method === 'fixed' ? <>OT rate (<Riyal /> / hr)</> : `OT multiplier (blank = ${settings.ot_multiplier}×)`}>
            <input className="input num" type="number" min="0" step="0.01" value={draft.ot_rate} onChange={(e) => set('ot_rate', e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Iqama</div>
        <div className="form-grid">
          <Field label="Iqama / ID number"><input className="input" inputMode="numeric" maxLength={10} placeholder="10 digits" value={draft.iqama_no} onChange={(e) => set('iqama_no', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Issue date"><DatePicker value={draft.iqama_issue_date} onChange={(v) => set('iqama_issue_date', v)} /></Field>
          <Field label="Expiry date"><DatePicker value={draft.iqama_expiry_date} onChange={(v) => set('iqama_expiry_date', v)} /></Field>
          <Field label="Work permit expiry"><DatePicker value={draft.work_permit_expiry_date} onChange={(v) => set('work_permit_expiry_date', v)} /></Field>
          <Field label="Tamin (insurance) expiry"><DatePicker value={draft.tamin_expiry_date} onChange={(v) => set('tamin_expiry_date', v)} /></Field>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Bank</div>
        <div className="form-grid">
          <Field label="Bank code"><input className="input" placeholder="e.g. RJHI, SNB" value={draft.bank_code} onChange={(e) => set('bank_code', e.target.value)} /></Field>
          <Field label="IBAN" className="span-2"><input className="input mono" placeholder="SA…" value={draft.iban} onChange={(e) => set('iban', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}
