// Page content is data from the site: every browser tool result that carries text, titles or URLs from a page is
// wrapped in one <page_content site="…"> fence, the site named by the browser (never by the page), with the "<" of any
// fence tag the page wrote escaped first so its text cannot close the fence early. One open and one close tag per result.

/** The site the fence names: host and port for a web page, else what kind of page it is. */
export function pageSite(url: string): string {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    if (u.protocol === 'artifact:') return 'artifact';
    if (u.protocol === 'file:') return 'local file';
    return u.protocol.replace(/:$/, '') || 'blank page';
  } catch {
    return 'blank page';
  }
}

const TAG = /<\s*\/?\s*page_content/gi;

/**
 * `text` with the "<" of every <page_content and </page_content written as &lt;. One pass: nothing is removed, so no
 * nesting of the tag (however deep) can put a fence tag back together.
 */
export function stripFence(text: string): string {
  return String(text ?? '').replace(TAG, (tag) => `&lt;${tag.slice(1)}`);
}

/** `text` from the page at `url`, fenced as page content. */
export function fencePage(url: string, text: string): string {
  const site = pageSite(url).replace(/["<>&\s]/g, '');
  return `<page_content site="${site}">${stripFence(text)}</page_content>`;
}
