'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * On narrow screens the A4 preview (210 mm / 297 mm wide) would force sideways scrolling.
 * Attach `ref` and `style` to the `.paper` element: it is zoomed down to fit its container and left
 * untouched (style undefined) when it already fits. Printing ignores the zoom (see globals.css).
 */
export function usePaperZoom(landscape = false) {
  const [zoom, setZoom] = useState(1);
  const stop = useRef<(() => void) | null>(null);

  const ref = useCallback((paper: HTMLElement | null) => {
    stop.current?.(); stop.current = null;
    const host = paper?.parentElement;
    if (!host) return;
    const natural = landscape ? 1123 : 794;   // 297 mm / 210 mm in CSS px
    const fit = () => {
      const cs = getComputedStyle(host);
      const avail = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setZoom(Math.min(1, avail / (natural + 2)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    stop.current = () => ro.disconnect();
  }, [landscape]);

  return { ref, style: zoom < 1 ? ({ zoom } as React.CSSProperties) : undefined };
}
