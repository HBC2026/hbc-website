'use client';
/** Editing state for one JSA: immutable updates, undo/redo, debounced autosave with version checking. */
import { produce, type Draft } from 'immer';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { loadJsa, saveJsa } from './client';
import type { JsaDoc } from './types';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
const AUTOSAVE_MS = 2500;
const HISTORY = 80;

export interface JsaEditor {
  doc: JsaDoc | null; getDoc: () => JsaDoc | null; loading: boolean; loadError: string | null;
  locked: boolean; saveState: SaveState; saveError: string | null; savedAt: Date | null;
  update: (recipe: (d: Draft<JsaDoc>) => void, coalesceKey?: string) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  save: () => Promise<boolean>; reload: () => Promise<void>;
}

export function useJsaDoc(id: string): JsaEditor {
  const [doc, setDoc] = useState<JsaDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [, bump] = useState(0);

  const docRef = useRef<JsaDoc | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const past = useRef<JsaDoc[]>([]);
  const future = useRef<JsaDoc[]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);

  const apply = (next: JsaDoc) => { docRef.current = next; setDoc(next); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await loadJsa(id);
      if (!d) { setLoadError('This JSA was not found. It may have been deleted.'); return; }
      past.current = []; future.current = []; dirty.current = false;
      apply(d); setLoadError(null); setSaveState('idle'); setSaveError(null);
    } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (saving.current) { await saving.current; if (!dirty.current) return true; }
    const d = docRef.current;
    if (!d || d.header.status === 'finalized' || !dirty.current) return true;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    dirty.current = false;
    setSaveState('saving');
    const p = (async () => {
      try {
        const version = await saveJsa(d);
        // keep any edits made while the request was in flight; only the version moves forward
        const cur = docRef.current ?? d;
        const merged = { ...cur, version };
        docRef.current = merged; setDoc(merged);
        setSaveError(null); setSavedAt(new Date());
        setSaveState(dirty.current ? 'dirty' : 'saved');
        return true;
      } catch (e) {
        dirty.current = true;
        setSaveError(e instanceof Error ? e.message : String(e)); setSaveState('error');
        return false;
      }
    })();
    saving.current = p;
    const ok = await p;
    saving.current = null;
    if (ok && dirty.current) schedule();
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { doSave(); }, AUTOSAVE_MS);
  }, [doSave]);

  const update = useCallback((recipe: (d: Draft<JsaDoc>) => void, coalesceKey?: string) => {
    const cur = docRef.current;
    if (!cur || cur.header.status === 'finalized') return;
    const next = produce(cur, recipe);
    if (next === cur) return;
    const now = Date.now();
    const same = coalesceKey && lastKey.current?.key === coalesceKey && now - lastKey.current.at < 1200;
    if (!same) { past.current.push(cur); if (past.current.length > HISTORY) past.current.shift(); }
    lastKey.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    future.current = [];
    apply(next); dirty.current = true;
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
    schedule();
    bump((n) => n + 1);
  }, [schedule]);

  const step = useCallback((from: RefObject<JsaDoc[]>, to: RefObject<JsaDoc[]>) => {
    const cur = docRef.current; const prev = from.current.pop();
    if (!cur || !prev) return;
    to.current.push(cur);
    // the version belongs to the server copy: keep the current one
    apply({ ...prev, version: cur.version }); dirty.current = true; lastKey.current = null;
    setSaveState('dirty'); schedule(); bump((n) => n + 1);
  }, [schedule]);

  // flush pending edits when leaving the page or hiding the tab
  useEffect(() => {
    const flush = () => { if (dirty.current) doSave(); };
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', flush);
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) doSave();
    };
  }, [doSave]);

  return {
    doc, getDoc: () => docRef.current, loading, loadError, locked: doc?.header.status === 'finalized', saveState, saveError, savedAt,
    update, undo: () => step(past, future), redo: () => step(future, past),
    canUndo: past.current.length > 0, canRedo: future.current.length > 0,
    save: doSave, reload,
  };
}
