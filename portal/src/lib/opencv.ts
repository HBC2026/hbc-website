/* eslint-disable @typescript-eslint/no-explicit-any */
const SRC = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

let pending: Promise<{ cv: any }> | null = null;

/** Loads OpenCV.js (about 10 MB, cached by the browser) the first time a scan is started. Resolves with `{ cv }`: the namespace is wrapped because OpenCV's own object has a `then` method, which would hang a promise resolved with it. */
export function loadOpenCv(): Promise<{ cv: any }> {
  if (typeof window === 'undefined') return Promise.reject(new Error('OpenCV needs a browser.'));
  const ready = () => { const cv = (window as any).cv; return cv && cv.Mat ? cv : null; };
  const now = ready();
  if (now) return Promise.resolve({ cv: now });
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    const fail = (msg: string) => { pending = null; reject(new Error(msg)); };
    const poll = (since: number) => {
      const cv = ready();
      if (cv) return resolve({ cv });
      if (Date.now() - since > 90_000) return fail('The scanner took too long to load.');
      setTimeout(() => poll(since), 100);
    };
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => poll(Date.now());
    s.onerror = () => { s.remove(); fail('Could not load the scanner. Check your connection.'); };
    document.head.appendChild(s);
  });
  return pending;
}
