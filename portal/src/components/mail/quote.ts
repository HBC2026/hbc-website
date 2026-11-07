/** Builds the quoted original that goes under a reply or forward. Remote images are dropped so opening a draft never "phones home". */
import { addrText, esc, longWhen, senderName, type MailMessage } from '@/lib/mail';

const stripRemoteImages = (html: string) => html.replace(/<img\b[^>]*\bsrc=["']https?:[^>]*>/gi, '');

function originalBody(m: MailMessage): string {
  return m.html_body ? stripRemoteImages(m.html_body) : `<div style="white-space:pre-wrap">${esc(m.text_body)}</div>`;
}

export function replyQuote(m: MailMessage): string {
  return `<br><div style="color:#555">On ${esc(longWhen(m.sent_at))}, ${esc(senderName(m))} wrote:</div>`
    + `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #c8c8c8;padding-left:1ex">${originalBody(m)}</blockquote>`;
}

export function forwardQuote(m: MailMessage): string {
  const line = (k: string, v: string) => `<b>${k}:</b> ${esc(v)}<br>`;
  return `<br><div style="border-top:1px solid #c8c8c8;padding-top:8px;color:#555">`
    + `${line('From', addrText({ name: m.from_name, address: m.from_addr }))}${line('Sent', longWhen(m.sent_at))}`
    + `${line('To', m.to_addrs.map(addrText).join(', '))}${m.cc_addrs.length ? line('Cc', m.cc_addrs.map(addrText).join(', ')) : ''}${line('Subject', m.subject)}</div><br>`
    + `<div>${originalBody(m)}</div>`;
}
