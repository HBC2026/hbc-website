import type { SVGProps } from 'react';

/** Small stroke icon set for the inbox (24x24 viewBox, currentColor). */
const P: Record<string, string[]> = {
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  draft: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8'],
  trash: ['M3 6h18', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  archive: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
  reply: ['M9 17l-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
  replyAll: ['M7 17l-5-5 5-5', 'M12 17l-5-5 5-5', 'M22 18v-2a4 4 0 0 0-4-4H7'],
  forward: ['M15 17l5-5-5-5', 'M4 18v-2a4 4 0 0 1 4-4h12'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 6l-10 7L2 6'],
  mailOpen: ['M21.2 8.4L12 2 2.8 8.4A2 2 0 0 0 2 10v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-.8-1.6z', 'M22 10l-10 6-10-6'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  search: ['M21 21l-4.35-4.35', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
  clip: ['M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  image: ['M3 3h18v18H3z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  listUl: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  listOl: ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  alignLeft: ['M17 10H3', 'M21 6H3', 'M21 14H3', 'M17 18H3'],
  alignCenter: ['M18 10H6', 'M21 6H3', 'M21 14H3', 'M18 18H6'],
  alignRight: ['M21 10H7', 'M21 6H3', 'M21 14H3', 'M21 18H7'],
  indent: ['M3 8l4 4-4 4', 'M21 12H11', 'M21 6H11', 'M21 18H11'],
  outdent: ['M7 8l-4 4 4 4', 'M21 12H11', 'M21 6H11', 'M21 18H11'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'],
  redo: ['M21 7v6h-6', 'M3 17a9 9 0 0 1 15-6.7L21 13'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  back: ['M15 18l-6-6 6-6'],
  quote: ['M3 21c3 0 7-1 7-8V5H4v6h4', 'M14 21c3 0 7-1 7-8V5h-6v6h4'],
  minus: ['M4 12h16'],
  clear: ['M7 21h10', 'M5 5l14 14', 'M9 4h10l-3 8'],
  check: ['M20 6L9 17l-5-5'],
  chevron: ['M6 9l6 6 6-6'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
};

export function Icon({ n, size = 16, ...rest }: { n: keyof typeof P | string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {(P[n] ?? []).map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
