const COLORS = ['#0f6cbd', '#8764b8', '#038387', '#c239b3', '#498205', '#ca5010', '#5c2e91', '#486991', '#ae8c00', '#a4262c'];

/** Round initials badge, colour chosen from the address so a sender always looks the same. */
export function Avatar({ name, addr, size = 36 }: { name: string; addr: string; size?: number }) {
  const label = (name || addr || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
  const parts = label.split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0;
  for (const ch of (addr || name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="ol-avatar" style={{ width: size, height: size, background: COLORS[h % COLORS.length], fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  );
}
