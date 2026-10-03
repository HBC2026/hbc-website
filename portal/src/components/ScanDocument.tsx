'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadOpenCv } from '@/lib/opencv';
import {
  applyFilter, canvasToJpeg, defaultCorners, detectCorners, rotateCanvas, toCanvas, warpPage,
  type Pt, type ScanFilter,
} from '@/lib/scan';

type Step = 'camera' | 'adjust' | 'result';
const FILTERS: { id: ScanFilter; label: string }[] = [
  { id: 'document', label: 'Document' }, { id: 'gray', label: 'Grayscale' }, { id: 'original', label: 'Original' },
];

/** Full-screen document scanner: live camera, automatic edge detection with draggable corners, flatten, clean-up filter. */
export function ScanDocument({ title = 'Scan document', onScan, onClose }: {
  title?: string; onScan: (file: File) => void; onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('camera');
  const [camError, setCamError] = useState('');
  const [engine, setEngine] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [corners, setCorners] = useState<Pt[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<HTMLCanvasElement | null>(null);
  const [filter, setFilter] = useState<ScanFilter>('document');
  const [resultUrl, setResultUrl] = useState('');
  const [error, setError] = useState('');

  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const main = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const stopCamera = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; }, []);

  // start loading the scanner engine right away so it is ready by the time a photo is taken
  useEffect(() => { loadOpenCv().then(() => setEngine('ready'), () => setEngine('failed')); }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const startCamera = useCallback(async () => {
    setCamError('');
    if (!navigator.mediaDevices?.getUserMedia) { setCamError('The camera is not available in this browser.'); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
    } catch {
      setCamError('Could not open the camera. Allow camera access, or choose a photo instead.');
    }
  }, []);

  useEffect(() => {
    if (step !== 'camera') return;
    startCamera();
    return stopCamera;
  }, [step, startCamera, stopCamera]);

  useEffect(() => stopCamera, [stopCamera]);

  async function enterAdjust(c: HTMLCanvasElement) {
    stopCamera();
    setSource(c); setError(''); setStep('adjust');
    setCorners(defaultCorners(c.width, c.height)); setNote('Finding the edges of the page…');
    try {
      const found = await detectCorners(c);
      if (found) { setCorners(found); setNote('Check the corners sit on the page edges.'); }
      else setNote('Couldn’t find the page edges automatically — drag the corners onto the page edges.');
    } catch {
      setNote('Automatic detection isn’t available — drag the corners onto the page edges.');
    }
  }

  function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    enterAdjust(toCanvas(v, v.videoWidth, v.videoHeight));
  }

  async function fromGallery(f: File | undefined | null) {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setCamError('Please choose a photo (JPEG / PNG).'); return; }
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const c = toCanvas(bmp, bmp.width, bmp.height);
      bmp.close();
      enterAdjust(c);
    } catch { setCamError('This image format is not supported. Use a JPEG or PNG photo.'); }
  }

  function rotate() {
    if (!source) return;
    const h = source.height;
    setSource(rotateCanvas(source));
    setCorners((cs) => cs.map((p) => ({ x: h - p.y, y: p.x })));
  }

  function moveHandle(e: React.PointerEvent) {
    if (drag.current === null || !stage.current || !source) return;
    const r = stage.current.getBoundingClientRect();
    const x = Math.min(source.width, Math.max(0, ((e.clientX - r.left) / r.width) * source.width));
    const y = Math.min(source.height, Math.max(0, ((e.clientY - r.top) / r.height) * source.height));
    const i = drag.current;
    setCorners((cs) => cs.map((p, j) => (j === i ? { x, y } : p)));
  }

  async function crop() {
    if (!source) return;
    setBusy(true); setError('');
    try {
      setPage(await warpPage(source, corners));
      setFilter('document'); setStep('result');
    } catch { setError('Could not crop the page. Move the corners and try again.'); }
    setBusy(false);
  }

  // re-render the result whenever the page or filter changes
  useEffect(() => {
    if (step !== 'result' || !page) return;
    let live = true, url = '';
    (async () => {
      try {
        const out = await applyFilter(page, filter);
        const blob = await canvasToJpeg(out, 0.6);
        url = URL.createObjectURL(blob);
        if (live) setResultUrl(url); else URL.revokeObjectURL(url);
      } catch { if (live) setError('Could not apply the filter.'); }
    })();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [step, page, filter]);

  async function use() {
    if (!page) return;
    setBusy(true); setError('');
    try {
      const blob = await canvasToJpeg(await applyFilter(page, filter), 0.88);
      onScan(new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    } catch { setError('Could not save the scan.'); setBusy(false); }
  }

  // size the stage to the largest box of the photo's aspect ratio that fits the available space
  useEffect(() => {
    const el = main.current;
    if (step !== 'adjust' || !el || !source) return;
    const fit = () => {
      const w = el.clientWidth - 32, h = el.clientHeight - 16;
      const k = Math.min(w / source.width, h / source.height);
      setBox({ w: Math.max(0, Math.floor(source.width * k)), h: Math.max(0, Math.floor(source.height * k)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step, source]);

  const pct = (p: Pt) => ({ left: `${(p.x / (source?.width || 1)) * 100}%`, top: `${(p.y / (source?.height || 1)) * 100}%` });

  const ui = (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="scan-bar">
        <strong>{title}</strong>
        <button type="button" className="scan-x" onClick={onClose} aria-label="Close scanner">×</button>
      </div>

      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={(e) => { fromGallery(e.target.files?.[0]); e.target.value = ''; }} />

      {step === 'camera' && (
        <>
          <div className="scan-main">
            <video ref={video} className="scan-video" playsInline muted />
            {!camError && <div className="scan-guide" aria-hidden />}
            {camError && <div className="scan-msg">{camError}</div>}
          </div>
          <div className="scan-foot">
            <button type="button" className="scan-btn" onClick={() => galleryRef.current?.click()}>Choose photo</button>
            <button type="button" className="scan-shutter" onClick={snap} disabled={!!camError} aria-label="Take photo" />
            <span className="scan-hint">{engine === 'loading' ? 'Loading scanner…' : engine === 'failed' ? 'Manual crop only' : 'Fit the page in the frame'}</span>
          </div>
        </>
      )}

      {step === 'adjust' && source && (
        <>
          <div className="scan-main" ref={main} onPointerMove={moveHandle} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <div className="scan-stage" ref={stage} style={{ width: box.w, height: box.h }}>
              <AdjustCanvas source={source} />
              <svg className="scan-poly" viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="none">
                <polygon points={corners.map((p) => `${p.x},${p.y}`).join(' ')} />
              </svg>
              {corners.map((p, i) => (
                <div key={i} className="scan-handle" style={pct(p)} onPointerDown={(e) => { drag.current = i; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }} />
              ))}
            </div>
          </div>
          <div className="scan-note">{error || note}</div>
          <div className="scan-foot">
            <button type="button" className="scan-btn" onClick={() => setStep('camera')} disabled={busy}>Retake</button>
            <button type="button" className="scan-btn" onClick={rotate} disabled={busy}>⟳ Rotate</button>
            <button type="button" className="scan-btn primary" onClick={crop} disabled={busy}>{busy ? 'Cropping…' : 'Crop'}</button>
          </div>
        </>
      )}

      {step === 'result' && (
        <>
          <div className="scan-main">{resultUrl ? <img className="scan-result" src={resultUrl} alt="Scanned page" /> : <div className="scan-msg">Processing…</div>}</div>
          <div className="scan-filters">
            {FILTERS.map((f) => (
              <button type="button" key={f.id} className={`scan-chip${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)} disabled={busy}>{f.label}</button>
            ))}
          </div>
          {error && <div className="scan-note">{error}</div>}
          <div className="scan-foot">
            <button type="button" className="scan-btn" onClick={() => setStep('adjust')} disabled={busy}>Back</button>
            <button type="button" className="scan-btn primary" onClick={use} disabled={busy || !resultUrl}>{busy ? 'Saving…' : 'Use scan'}</button>
          </div>
        </>
      )}
    </div>
  );
  return createPortal(ui, document.body);
}

/** Shows the source canvas by copying its pixels into a display canvas that fills the stage. */
function AdjustCanvas({ source }: { source: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = source.width; c.height = source.height;
    c.getContext('2d')!.drawImage(source, 0, 0);
  }, [source]);
  return <canvas ref={ref} className="scan-canvas" />;
}
