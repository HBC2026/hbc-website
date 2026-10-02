import type { Role } from './types';

/** UI-level permissions. The database (RLS + functions) is the real enforcement; this only hides controls. */
export type Action =
  | 'employees:write' | 'attendance:write' | 'payroll:write' | 'payroll:reopen'
  | 'quotations:write' | 'clients:write' | 'settings:write' | 'pettycash:write';

const RULES: Record<Action, Role[]> = {
  'employees:write': ['administrator', 'payroll'],
  'attendance:write': ['administrator', 'attendance'],
  'payroll:write': ['administrator', 'payroll'],
  'payroll:reopen': ['administrator'],
  'quotations:write': ['administrator', 'quotations'],
  'clients:write': ['administrator', 'quotations'],
  'settings:write': ['administrator'],
  'pettycash:write': ['administrator', 'payroll'],
};

export const can = (role: Role | undefined, action: Action) => !!role && RULES[action].includes(role);

export const ROLE_LABEL: Record<Role, string> = {
  administrator: 'Administrator', payroll: 'Payroll', attendance: 'Attendance',
  quotations: 'Quotations', viewer: 'Viewer',
};

export const ROLES: Role[] = ['administrator', 'payroll', 'attendance', 'quotations', 'viewer'];

export const PAYROLL_SIDE: Role[] = ['administrator', 'payroll', 'viewer'];
export const ATTENDANCE_SIDE: Role[] = ['administrator', 'payroll', 'attendance', 'viewer'];
export const PETTY_SIDE: Role[] = ['administrator', 'payroll', 'viewer'];
export const QUOTE_SIDE: Role[] = ['administrator', 'quotations', 'viewer'];
