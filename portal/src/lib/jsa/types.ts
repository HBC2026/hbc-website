/** JSA Management shared types and defaults. Pure data: safe to import from the browser and from route handlers. */

export type JsaStatus = 'draft' | 'finalized';
export type ControlOrigin = 'manual' | 'ai' | 'kb' | 'template';

export interface JControl { id: string; text: string; origin: ControlOrigin; edited: boolean }
export interface JHazard { id: string; category: string; custom_name: string; instructions: string; controls: JControl[] }
export interface JActivity { id: string; title: string; equipment: string; instructions: string; hazards: JHazard[] }

export interface JsaHeader {
  number: string; revision: number; status: JsaStatus; project: string; client: string; location: string;
  work_description: string; jsa_date: string; prepared_by: string; equipment: string;
  additional_instructions: string; ai_instructions: string;
}
export interface JsaDoc { id: string; version: number; header: JsaHeader; activities: JActivity[]; finalized_at: string | null }

export interface JsaRow {
  id: string; number: string; revision: number; status: JsaStatus; project: string; client: string; location: string;
  work_description: string; jsa_date: string; prepared_by: string; updated_at: string; created_at: string; deleted_at: string | null;
}

export interface JsaRevision { id: string; revision: number; created_at: string; finalized_by_name: string; snapshot: { header: JsaHeader; activities: JActivity[] } }

export interface KbEntry {
  id: string; work_activity: string; hazard: string; equipment: string; controls: string[]; applicable_rules: string;
  source: string; tags: string[]; status: 'approved' | 'archived'; created_at: string; updated_at: string;
}
export interface SafetyRule {
  id: string; kind: 'company' | 'client' | 'equipment'; title: string; body: string; equipment: string; source: string; active: boolean;
  created_at: string; updated_at: string;
}
export interface JsaTemplate { id: string; name: string; description: string; content: { activities: JActivity[] }; deleted_at: string | null; updated_at: string }

export interface ExportTemplate {
  id: string; name: string; orientation: 'portrait' | 'landscape'; showLogo: boolean;
  signatures: string[];            // signature box labels, e.g. ["Prepared By", "Reviewed By", "Approved By"]
  footer: string;
}

export interface JsaSettings {
  hazard_categories: string[];
  default_control_count: number;
  numbering_format: string;
  company_instructions: string;
  ai_preferences: string;
  export_templates: ExportTemplate[];
}

export const OTHER_HAZARD = 'Other / Custom Hazard';

export const DEFAULT_HAZARD_CATEGORIES = [
  'Manual Task & Tools', 'Machinery & Equipment', 'Working at Height / Scaffold', 'Electricity', 'Fire',
  'Chemical Hazard', 'Falling Objects', 'Lifting & Carrying', 'Slip, Trip & Falls', 'On-Site Vehicle',
  'Overhead Crane', 'Material in Uncontrolled Motion', 'Objects with Sharp Edges', 'Noise', 'Inadequate Lighting',
  'Biological Hazard', 'Interference', OTHER_HAZARD,
];

export const DEFAULT_EXPORT_TEMPLATES: ExportTemplate[] = [
  { id: 'standard', name: 'Standard (landscape, 3 signatures)', orientation: 'landscape', showLogo: true, signatures: ['Prepared By', 'Reviewed By', 'Approved By'], footer: '' },
  { id: 'portrait', name: 'Portrait (prepared by only)', orientation: 'portrait', showLogo: true, signatures: ['Prepared By'], footer: '' },
  { id: 'jobowner', name: 'Landscape with Job Owner acknowledgement', orientation: 'landscape', showLogo: true, signatures: ['Prepared By', 'Reviewed By', 'Client Job Owner'], footer: '' },
];

export const DEFAULT_JSA_SETTINGS: JsaSettings = {
  hazard_categories: DEFAULT_HAZARD_CATEGORIES,
  default_control_count: 20,
  numbering_format: 'JSA-{YYYY}-{NNN}',
  company_instructions: '',
  ai_preferences: '',
  export_templates: DEFAULT_EXPORT_TEMPLATES,
};

export const REVIEW_NOTICE = 'Generated content requires review by a competent safety professional before use on site. Finalization is an internal document-management action and does not replace any approval required by the client or the site permit process.';

export const uid = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });

export const newControl = (text: string, origin: ControlOrigin = 'manual'): JControl => ({ id: uid(), text, origin, edited: false });
export const newHazard = (category = OTHER_HAZARD, custom_name = ''): JHazard => ({ id: uid(), category, custom_name, instructions: '', controls: [] });
export const newActivity = (title = ''): JActivity => ({ id: uid(), title, equipment: '', instructions: '', hazards: [] });

/** Display name of a hazard: the custom text if given, otherwise its category. */
export const hazardName = (h: Pick<JHazard, 'category' | 'custom_name'>): string => {
  const c = h.custom_name.trim();
  if (!c) return h.category;
  if (h.category === OTHER_HAZARD || c.toLowerCase().includes(h.category.toLowerCase())) return c;
  return `${h.category} — ${c}`;
};

export function emptyHeader(over: Partial<JsaHeader> = {}): JsaHeader {
  return {
    number: '', revision: 0, status: 'draft', project: '', client: 'TENARIS', location: '', work_description: '',
    jsa_date: new Date().toISOString().slice(0, 10), prepared_by: '', equipment: '', additional_instructions: '', ai_instructions: '', ...over,
  };
}
