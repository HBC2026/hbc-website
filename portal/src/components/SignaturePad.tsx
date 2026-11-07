'use client';
import { useEffect, useRef, useState } from 'react';

/** Finger / mouse signature box. Reports a PNG data URL, or '' while empty. */
export function SignaturePad({ onChange }: { onChange: (png: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const g = c.getContext('2d')!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111827';
  }, []);

  const pt = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const g = ref.current!.getContext('2d')!, p = pt(e);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + 0.01, p.y + 0.01); g.stroke();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const g = ref.current!.getContext('2d')!, p = pt(e);
    g.lineTo(p.x, p.y); g.stroke();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange(ref.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setEmpty(true); onChange('');
  };

  return (
    <div className="sig-wrap">
      <canvas ref={ref} className="sig-pad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {empty && <div className="sig-hint">Sign here</div>}
      <button type="button" className="btn sm sig-clear" onClick={clear}>Clear</button>
    </div>
  );
}
