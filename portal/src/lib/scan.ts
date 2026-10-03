/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadOpenCv } from './opencv';

export interface Pt { x: number; y: number }
export type ScanFilter = 'document' | 'gray' | 'original';

const DETECT_SIDE = 600;
const MAX_SIDE = 2200;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Orders four points as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(p: Pt[]): Pt[] {
  const bySum = [...p].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...p].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** Four corners inset from the image edges, used when detection finds nothing. */
export function defaultCorners(w: number, h: number): Pt[] {
  const mx = w * 0.1, my = h * 0.1;
  return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
}

/** Finds the largest four-sided shape (the paper) in the image. Returns corners in source-pixel coordinates, or null. */
export async function detectCorners(source: HTMLCanvasElement): Promise<Pt[] | null> {
  const { cv } = await loadOpenCv();
  const k = Math.min(1, DETECT_SIDE / Math.max(source.width, source.height));
  const small = document.createElement('canvas');
  small.width = Math.round(source.width * k);
  small.height = Math.round(source.height * k);
  small.getContext('2d')!.drawImage(source, 0, 0, small.width, small.height);

  const garbage: any[] = [];
  const track = <T,>(m: T): T => { garbage.push(m); return m; };
  try {
    const rgba = track(cv.imread(small));
    const gray = track(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const edges = track(new cv.Mat());
    cv.Canny(blur, edges, 60, 180);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

    const bright = track(new cv.Mat());
    cv.threshold(blur, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bright, bright, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);

    const minArea = small.width * small.height * 0.15;
    for (const mask of [edges, bright]) {
      const contours = track(new cv.MatVector());
      const hierarchy = track(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const found: { area: number; pts: Pt[] }[] = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area >= minArea) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const pts: Pt[] = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2] / k, y: approx.data32S[j * 2 + 1] / k });
            found.push({ area, pts });
          }
          approx.delete();
        }
        c.delete();
      }
      if (found.length) {
        found.sort((a, b) => b.area - a.area);
        return orderCorners(found[0].pts);
      }
    }
    return null;
  } finally {
    garbage.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}

/** Flattens the quadrilateral to a straight, upright page. */
export async function warpPage(source: HTMLCanvasElement, corners: Pt[]): Promise<HTMLCanvasElement> {
  const { cv } = await loadOpenCv();
  const [tl, tr, br, bl] = orderCorners(corners);
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));

  const src = cv.imread(source);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const m = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, m, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    cv.imshow(out, dst);
    return out;
  } finally { [src, dst, from, to, m].forEach((x) => x.delete()); }
}

/** Applies the scan look. "document" evens out shadows and whitens the paper; "gray" is plain grayscale. */
export async function applyFilter(page: HTMLCanvasElement, mode: ScanFilter): Promise<HTMLCanvasElement> {
  if (mode === 'original') return page;
  const { cv } = await loadOpenCv();
  const garbage: any[] = [];
  const track = <T,>(m: T): T => { garbage.push(m); return m; };
  try {
    const rgba = track(cv.imread(page));
    const gray = track(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    let result = gray;
    if (mode === 'document') {
      // estimate the lighting from a shrunken copy, then divide it out so shadows disappear
      const tiny = track(new cv.Mat());
      cv.resize(gray, tiny, new cv.Size(0, 0), 0.25, 0.25, cv.INTER_AREA);
      const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      cv.dilate(tiny, tiny, kernel);
      cv.medianBlur(tiny, tiny, 11);
      const bg = track(new cv.Mat());
      cv.resize(tiny, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
      const flat = track(new cv.Mat());
      cv.divide(gray, bg, flat, 255);
      // gentle contrast stretch: lift near-white to white, darken the ink
      const stretched = track(new cv.Mat());
      flat.convertTo(stretched, -1, 1.25, -45);
      result = stretched;
    }
    const out = document.createElement('canvas');
    out.width = page.width; out.height = page.height;
    cv.imshow(out, result);
    return out;
  } finally {
    garbage.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}

/** Rotates a canvas a quarter turn clockwise. */
export function rotateCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = c.height; out.height = c.width;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(c, 0, 0);
  return out;
}

/** Draws an image/video frame onto a canvas, capped at MAX_SIDE. */
export function toCanvas(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToJpeg(c: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the scan.'))), 'image/jpeg', quality));
}
