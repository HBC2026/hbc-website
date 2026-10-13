/** Decodes a few HTML entities mammoth can emit. */
const unesc = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Word (mammoth HTML) -> text. Tables become tab-separated rows (cells with several paragraphs are quoted) so the table parser can read them. */
export function htmlToText(html: string): string {
  let h = html;
  h = h.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    return '\n' + rows.map((tr) => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((td) => {
      const inner = td.replace(/<\/p>\s*<p>/gi, '\n').replace(/<\/li>\s*<li>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      const t = unesc(inner).trim().replace(/"/g, '""');
      return /[\n\t"]/.test(t) ? `"${t}"` : t;
    }).join('\t')).join('\n') + '\n';
  });
  h = h.replace(/<\/(p|h\d|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return unesc(h).replace(/\n{3,}/g, '\n\n').trim();
}


