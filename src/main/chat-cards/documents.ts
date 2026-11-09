// Documents the agent wrote, opened from their card in the chat. Markdown and plain text are shown in the artifact
// viewer through artifact://view/_doc/<token>/<name> (artifacts.ts serves it); an HTML file is opened as itself
// (file:), so the pages and pictures beside it load too; a PDF goes to the Mac's default app. The tokens live in
// memory and name only files a card asked for; every request reads the file again. No Electron here.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DocumentKind = 'markdown' | 'text' | 'html' | 'pdf';

const KINDS: Record<string, DocumentKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
};

/** Larger files are opened with the default app instead of the viewer */
export const MAX_VIEWER_BYTES = 4 * 1024 * 1024;

/** A document's kind by its extension, or null for a file that is not one. */
export function documentKind(file: string): DocumentKind | null {
  return KINDS[path.extname(String(file ?? '')).toLowerCase()] ?? null;
}

const byToken = new Map<string, string>();
const tokenByPath = new Map<string, string>();

/** The URL path (after artifact://view/) of the viewer for a Markdown or text file; the same file keeps its URL. */
export function documentViewerPath(file: string): string {
  let token = tokenByPath.get(file);
  if (!token) {
    token = randomBytes(12).toString('hex');
    byToken.set(token, file);
    tokenByPath.set(file, token);
  }
  return `_doc/${token}/${encodeURIComponent(path.basename(file))}`;
}

/** The file behind a viewer token, while it is still a Markdown or text file that fits the viewer. */
export function documentFile(token: string): string | null {
  const file = byToken.get(token);
  if (!file) return null;
  const kind = documentKind(file);
  if (kind !== 'markdown' && kind !== 'text') return null;
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_VIEWER_BYTES ? file : null;
  } catch {
    return null;
  }
}

/** The document's title for the viewer: a Markdown file's first heading, else its file name. */
export function documentTitle(file: string, source: string): string {
  if (documentKind(file) === 'markdown') {
    const m = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/m.exec(source.slice(0, 4000));
    if (m) return m[1].trim();
  }
  return path.basename(file);
}
