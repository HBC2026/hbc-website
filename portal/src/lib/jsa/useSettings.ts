'use client';
import { useQuery } from '@/lib/hooks';
import { loadJsaSettings } from './client';
import { DEFAULT_JSA_SETTINGS, type JsaSettings } from './types';

/** The JSA settings of the current company (hazard categories, default control count, templates for export, …). */
export function useJsaSettings(): { settings: JsaSettings; loading: boolean; error: string | null; reload: () => Promise<void> } {
  const q = useQuery(loadJsaSettings, []);
  return { settings: q.data ?? DEFAULT_JSA_SETTINGS, loading: q.loading, error: q.error, reload: q.reload };
}
