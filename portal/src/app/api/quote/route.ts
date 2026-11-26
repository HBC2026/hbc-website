export const runtime = 'nodejs';

// Public coring-quote requests from the website modal, emailed via Resend.
// Env (server-side only): RESEND_API_KEY, QUOTE_TO_EMAIL (default contact@hbcgcc.com),
// QUOTE_FROM_EMAIL (a sender on a domain verified in Resend).

const FIELDS: [string, string, number][] = [
  ['name', 'Name', 120], ['company', 'Company', 160], ['phone', 'Phone', 40], ['email', 'Email', 160],
  ['material', 'Material', 60], ['materialOther', 'Material (described)', 120], ['element', 'Element', 60], ['elementOther', 'Element (described)', 120], ['diameter', 'Core diameter (mm)', 60],
  ['qty', 'Number of cores', 20], ['depth', 'Depth (mm)', 60], ['location', 'Site location', 200],
  ['notes', 'Details', 2000],
];

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const reply = (body: object, status = 200) => Response.json(body, { status });

// Best-effort per-IP throttle (per server instance) so the public form cannot be used to flood the inbox or burn email quota.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now(), win = 10 * 60_000, max = 5;
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < win);
  if (recent.length >= max) { hits.set(ip, recent); return true; }
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= win)) hits.delete(k);
  return false;
}

export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return reply({ error: 'Too many requests. Please try again later or call us.' }, 429);
  const origin = req.headers.get('origin');
  let originHost = ''; try { originHost = origin ? new URL(origin).host : ''; } catch { originHost = 'invalid'; }
  if (origin && originHost !== req.headers.get('host')) return reply({ error: 'Invalid request.' }, 403);
  if (Number(req.headers.get('content-length') ?? 0) > 20_000) return reply({ error: 'Request too large.' }, 413);
  let raw: Record<string, unknown>;
  try { raw = await req.json(); } catch { return reply({ error: 'Invalid request.' }, 400); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply({ error: 'Invalid request.' }, 400);
  if (raw.website) return reply({ ok: true }); // honeypot: bots fill this, pretend success

  const d: Record<string, string> = {};
  for (const [k, , max] of FIELDS) d[k] = String(raw[k] ?? '').trim().slice(0, max);
  // Accept Arabic-Indic digits in numeric fields
  const digits = (v: string) => v.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6F0));
  for (const k of ['phone', 'diameter', 'qty', 'depth']) d[k] = digits(d[k]);
  if (d.material !== 'Other') d.materialOther = '';
  if (d.element !== 'Other') d.elementOther = '';
  if ((d.material === 'Other' && d.materialOther.length < 2) || (d.element === 'Other' && d.elementOther.length < 2))
    return reply({ error: 'Please add a short description for "Other".' }, 400);

  if (d.name.length < 2) return reply({ error: 'Please enter your name.' }, 400);
  if (!/^[+\d][\d\s()-]{6,}$/.test(d.phone)) return reply({ error: 'Please enter a valid phone number.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return reply({ error: 'Please enter a valid email.' }, 400);
  const required = ['company', 'material', 'element', 'diameter', 'qty', 'depth', 'location', 'notes'];
  if (required.some(k => !d[k])) return reply({ error: 'Please fill in all fields.' }, 400);
  if (['diameter', 'qty', 'depth'].some(k => !(parseFloat(d[k]) > 0))) return reply({ error: 'Please enter valid numbers for size, quantity and depth.' }, 400);

  const key = process.env.RESEND_API_KEY;
  if (!key) return reply({ error: 'Quote requests are not configured yet. Please call us.' }, 503);

  const rows = FIELDS.filter(([k]) => d[k]);
  const html = `<h2>New concrete coring quote request</h2><table cellpadding="6" style="border-collapse:collapse">${
    rows.map(([k, label]) => `<tr><td style="color:#555;vertical-align:top"><b>${label}</b></td><td>${esc(d[k]).replace(/\n/g, '<br>')}</td></tr>`).join('')
  }</table>`;
  const text = 'New concrete coring quote request\n\n' + rows.map(([k, label]) => `${label}: ${d[k]}`).join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.QUOTE_FROM_EMAIL || 'HBC Website <onboarding@resend.dev>',
      to: [process.env.QUOTE_TO_EMAIL || 'contact@hbcgcc.com'],
      ...(d.email ? { reply_to: d.email } : {}),
      subject: `Coring quote request - ${d.name}`,
      html, text,
    }),
  });
  if (!res.ok) return reply({ error: 'We could not send your request. Please call us.' }, 502);
  return reply({ ok: true });
}
