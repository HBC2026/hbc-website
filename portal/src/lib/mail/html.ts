/** Server-side HTML helpers shared by the sync (incoming mail) and send (outgoing mail) routes. */
import sanitizeHtml from 'sanitize-html';

export const SAFE_HTML: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'h1', 'h2', 'span', 'u', 's', 'strike', 'font', 'center'],
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'width', 'height', 'bgcolor', 'color', 'dir', 'border', 'cellpadding', 'cellspacing'],
    a: ['href', 'name', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], font: ['face', 'size', 'color'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
};

export const cleanHtml = (html: string) => sanitizeHtml(html, SAFE_HTML);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Plain-text alternative for an HTML message. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m).replace(/\n{3,}/g, '\n\n').trim();
}
