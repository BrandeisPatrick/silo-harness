// Artifacts: self-contained deliverables the model makes with create_artifact (a page, a diagram, a document, a
// code sample). They are stored per session under <userData>/artifacts/<sessionId>/ and shown in the Browser pane
// through the artifact:// scheme: HTML renders as a page, SVG as an image, Markdown and code in a viewer that
// uses the app's own renderer modules (markdown.js, highlight.js) and stylesheet, so they look like the chat.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactInfo, ArtifactKind } from '../shared/types';
import { documentFile, documentTitle, documentKind } from './chat-cards/documents';
import { localImageFile } from './images/local';
import { servableImage } from './images/sniff';
import type { Session } from './sessions';

export const ARTIFACT_SCHEME = 'artifact';
/** Every artifact URL lives on one host so the viewer, the app modules and the files share an origin. */
const HOST = 'view';
const KINDS: ArtifactKind[] = ['html', 'markdown', 'svg', 'code'];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 200;
/** Renderer modules the viewer may load (markdown.js and what it imports) */
const APP_FILES = new Set(['artifact-viewer.js', 'markdown.js', 'highlight.js', 'dom.js', 'icons.js', 'styles.css']);
const CODE_EXT: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx', python: 'py', py: 'py', json: 'json', css: 'css',
  html: 'html', shell: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', go: 'go', rust: 'rs', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  ruby: 'rb', rb: 'rb', swift: 'swift', kotlin: 'kt', yaml: 'yaml', yml: 'yaml', markdown: 'md', md: 'md', sql: 'sql', toml: 'toml', xml: 'xml',
};
const KIND_LABEL: Record<ArtifactKind, string> = { html: 'HTML', markdown: 'Markdown', svg: 'SVG', code: 'Code' };

export interface ArtifactInput {
  id?: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  content: string;
}

export interface ArtifactStoreOptions {
  /** <userData>/artifacts */
  root: string;
  /** dist/renderer, for the viewer's modules and stylesheet */
  rendererDir: string;
}

export type Resolved = { kind: 'file'; path: string } | { kind: 'page'; html: string };

/** The script CDNs an HTML artifact may load from (claude.ai artifacts allow the same few). */
export const ARTIFACT_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'] as const;

/**
 * The Content-Security-Policy of every artifact: response. An HTML artifact runs its own inline code and the CDNs'
 * scripts and styles, and sends nothing anywhere: no fetch, no beacon, no image, form or frame off the artifact, no
 * WebSocket or worker that could. What a model that read a secret writes into a page stays in the page.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' ${ARTIFACT_CDNS.join(' ')}`,
  `style-src 'self' 'unsafe-inline' ${ARTIFACT_CDNS.join(' ')} https://fonts.googleapis.com`,
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

// No `webrtc 'block'`: Electron 45's Chromium logs "Unrecognized Content-Security-Policy directive 'webrtc'" and
// ignores it, so a peer connection's ICE servers are the one way out the CSP does not close.

/** `headers` with the artifact CSP added (the viewer pages keep their stricter one in a meta tag as well). */
export function artifactHeaders(headers: Headers | Record<string, string> = {}): Headers {
  const h = new Headers(headers);
  h.set('Content-Security-Policy', ARTIFACT_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  return h;
}

/**
 * The artifact: scheme's handler (index.ts gives it the store and net.fetch): a generated page, or a stored file,
 * always with the artifact CSP, whatever it is (an HTML artifact opened through its files/ address included).
 */
export async function serveArtifactRequest(url: string, store: { resolve(url: string): Resolved | null } | null | undefined, fetchFile: (fileUrl: string) => Promise<Response>): Promise<Response> {
  const r = store?.resolve(url);
  if (!r) return new Response('Not found', { status: 404, headers: artifactHeaders({ 'content-type': 'text/plain' }) });
  if (r.kind === 'page') return new Response(r.html, { headers: artifactHeaders({ 'content-type': 'text/html; charset=utf-8' }) });
  const res = await fetchFile(pathToFileURL(r.path).href);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: artifactHeaders(res.headers) });
}

function safeId(s: string): string | null {
  return /^[\w-]{1,64}$/.test(s) ? s : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON for embedding in a <script type="application/json"> block: no "<" survives, so no tag can close it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function artifactFileName(info: Pick<ArtifactInfo, 'id' | 'kind' | 'language'>): string {
  const ext = info.kind === 'html' ? 'html' : info.kind === 'markdown' ? 'md' : info.kind === 'svg' ? 'svg' : CODE_EXT[(info.language ?? '').toLowerCase()] ?? 'txt';
  return `${info.id}.${ext}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function kindLabel(info: Pick<ArtifactInfo, 'kind' | 'language'>): string {
  return info.kind === 'code' && info.language ? info.language : KIND_LABEL[info.kind];
}

export class ArtifactStore {
  constructor(private readonly opts: ArtifactStoreOptions) {}

  dirFor(sessionId: string): string {
    return path.join(this.opts.root, safeId(sessionId) ?? 'invalid');
  }

  list(session: Session): ArtifactInfo[] {
    return Object.values(session.artifacts ?? {}).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(session: Session, id: string): ArtifactInfo | undefined {
    return session.artifacts?.[id];
  }

  content(session: Session, id: string): string {
    const info = this.must(session, id);
    return fs.readFileSync(info.path, 'utf8');
  }

  /** Writes the artifact (new, or a new version of an existing id) and records it on the session. */
  save(session: Session, input: ArtifactInput): { info: ArtifactInfo; action: 'created' | 'updated' } {
    if (!KINDS.includes(input.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    const content = String(input.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (!content.trim()) throw new Error('content is empty');
    if (bytes > MAX_BYTES) throw new Error(`content is ${formatBytes(bytes)}; the limit is ${formatBytes(MAX_BYTES)}`);
    const title = String(input.title ?? '').trim().slice(0, 120) || 'Untitled';
    const language = input.language ? String(input.language).trim().slice(0, 32) : undefined;
    session.artifacts ??= {};
    const existing = input.id ? session.artifacts[input.id] : undefined;
    if (input.id && !existing) {
      if (!safeId(input.id)) throw new Error('id may only contain letters, digits, - and _');
      if (Object.keys(session.artifacts).length >= MAX_ARTIFACTS) throw new Error('too many artifacts in this session');
    }
    const id = input.id && existing ? input.id : input.id && safeId(input.id) ? input.id : this.nextId(session);
    const dir = this.dirFor(session.id);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const info: ArtifactInfo = {
      id,
      sessionId: session.id,
      title,
      kind: input.kind,
      language: input.kind === 'code' ? language : undefined,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      bytes,
      url: `${ARTIFACT_SCHEME}://${HOST}/${session.id}/${id}`,
      path: '',
    };
    info.path = path.join(dir, artifactFileName(info));
    if (existing && existing.path !== info.path) fs.rmSync(existing.path, { force: true });
    fs.writeFileSync(info.path, content);
    session.artifacts[id] = info;
    this.writeMeta(session);
    return { info, action: existing ? 'updated' : 'created' };
  }

  /** Copies a session's artifacts to a forked session and rewrites their paths and URLs. */
  copy(from: Session, to: Session): void {
    const list = this.list(from);
    if (!list.length) return;
    const dir = this.dirFor(to.id);
    fs.mkdirSync(dir, { recursive: true });
    to.artifacts = {};
    for (const a of list) {
      const target = path.join(dir, path.basename(a.path));
      try {
        fs.copyFileSync(a.path, target);
      } catch {
        continue;
      }
      to.artifacts[a.id] = { ...a, sessionId: to.id, path: target, url: `${ARTIFACT_SCHEME}://${HOST}/${to.id}/${a.id}` };
    }
    this.writeMeta(to);
  }

  remove(sessionId: string): void {
    if (!safeId(sessionId)) return;
    fs.rmSync(this.dirFor(sessionId), { recursive: true, force: true });
  }

  /**
   * Maps an artifact:// URL to a file or a generated page:
   *   artifact://view/_app/<module>            renderer module or stylesheet for the viewer
   *   artifact://view/<session>/<id>           the artifact: the HTML page itself, or a viewer for the other kinds
   *   artifact://view/<session>/files/<name>   a raw stored file (the viewer's <img> for SVG)
   *   artifact://view/<session>/images/<file>  an image the model showed (show_image): img-<n>.<ext> in that session's images folder
   *   artifact://view/_local/<token>/<name>    a local image a Markdown reply named (images.resolve made the token)
   *   artifact://view/_doc/<token>/<name>      a Markdown or text file the agent wrote, in the viewer (its card made the token)
   * Images are only served when their content is an image.
   */
  resolve(url: string): Resolved | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== `${ARTIFACT_SCHEME}:` || u.host !== HOST) return null;
    const parts = u.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return '';
      }
    });
    if (parts[0] === '_app' && parts.length === 2 && APP_FILES.has(parts[1])) {
      const file = path.join(this.opts.rendererDir, parts[1]);
      return fs.existsSync(file) ? { kind: 'file', path: file } : null;
    }
    if (parts[0] === '_local' && parts.length === 3) {
      const file = localImageFile(parts[1]);
      return file ? { kind: 'file', path: file } : null;
    }
    if (parts[0] === '_doc' && parts.length === 3) return this.documentPage(parts[1]);
    const sessionId = parts[0] && safeId(parts[0]);
    if (!sessionId) return null;
    if (parts[1] === 'images') return parts.length === 3 ? this.storedImage(sessionId, parts[2]) : null;
    const meta = this.readMeta(sessionId);
    if (parts[1] === 'files' && parts.length === 3) {
      const name = path.basename(parts[2]);
      const info = Object.values(meta).find((a) => path.basename(a.path) === name);
      return info && fs.existsSync(info.path) ? { kind: 'file', path: info.path } : null;
    }
    if (parts.length !== 2) return null;
    const info = meta[parts[1]];
    if (!info || !fs.existsSync(info.path)) return null;
    if (info.kind === 'html') return { kind: 'file', path: info.path };
    return { kind: 'page', html: this.viewerHtml(info, fs.readFileSync(info.path, 'utf8')) };
  }

  /** The viewer page for Markdown, code and SVG artifacts. `meta` replaces the line beside the title ("HTML · v2 · 4 KB"). */
  viewerHtml(info: ArtifactInfo, source: string, meta?: string): string {
    const title = escapeHtml(info.title);
    const head =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'">` +
      `<title>${title}</title><link rel="stylesheet" href="/_app/styles.css">` +
      `<style>
html, body { height: auto; min-height: 100%; overflow: auto; user-select: text; -webkit-user-select: text; display: block; }
body { margin: 0; background: var(--bg-100); color: var(--text-100); font: 16px/24px var(--font); -webkit-font-smoothing: antialiased; }
.artifact { max-width: 760px; margin: 0 auto; padding: 36px 32px 96px; }
.artifact-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 24px; padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle); }
.artifact-head h1 { margin: 0; font: 600 20px/28px var(--font); color: var(--text-100); }
.artifact-head .meta { font-size: 12px; line-height: 16px; color: var(--text-400); white-space: nowrap; }
.artifact .md { font-size: 15px; line-height: 24px; }
.artifact .md h1 { font-size: 24px; line-height: 32px; margin: 32px 0 12px; }
.artifact .md h2 { font-size: 19px; line-height: 28px; margin: 28px 0 8px; }
.artifact.code { max-width: none; padding: 24px 24px 64px; }
.artifact.code pre { margin: 0; padding: 16px; border: 1px solid var(--border-subtle); border-radius: var(--r-card); background: var(--code-bg); font: 13px/20px var(--mono); overflow: auto; tab-size: 4; }
.artifact.code .ln { display: block; counter-increment: line; }
.artifact.code .ln::before { content: counter(line); display: inline-block; width: 3ch; margin-right: 16px; text-align: right; color: var(--text-400); user-select: none; -webkit-user-select: none; }
.artifact.code pre { counter-reset: line; }
.artifact.svg { max-width: none; display: flex; flex-direction: column; min-height: 100vh; box-sizing: border-box; }
.artifact.svg .stage { flex: 1; display: flex; align-items: center; justify-content: center; }
.artifact.svg img { max-width: 100%; max-height: calc(100vh - 140px); }
</style></head>`;
    const metaLine = `<span class="meta">${escapeHtml(meta ?? `${kindLabel(info)} · v${info.version} · ${formatBytes(info.bytes)}`)}</span>`;
    if (info.kind === 'svg') {
      return (
        head +
        `<body><main class="artifact svg"><div class="artifact-head"><h1>${title}</h1>${metaLine}</div>` +
        `<div class="stage"><img src="/${encodeURIComponent(info.sessionId)}/files/${encodeURIComponent(path.basename(info.path))}" alt="${title}"></div></main></body></html>`
      );
    }
    const data = `<script id="src" type="application/json">${embedJson({ kind: info.kind, language: info.language ?? null, source })}</script>`;
    if (info.kind === 'code') {
      return (
        head +
        `<body><main class="artifact code"><div class="artifact-head"><h1>${title}</h1>${metaLine}</div><pre id="code"></pre></main>${data}<script type="module" src="/_app/artifact-viewer.js"></script></body></html>`
      );
    }
    return (
      head +
      `<body><main class="artifact"><div class="artifact-head"><h1>${title}</h1>${metaLine}</div><div class="md" id="md"></div></main>${data}<script type="module" src="/_app/artifact-viewer.js"></script></body></html>`
    );
  }

  // ---- internals ----

  /** A Markdown or text file the agent wrote, in the viewer: Markdown rendered, plain text as numbered lines. */
  private documentPage(token: string): Resolved | null {
    const file = documentFile(token);
    if (!file) return null;
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const markdown = documentKind(file) === 'markdown';
    const bytes = Buffer.byteLength(source);
    const info: ArtifactInfo = { id: 'document', sessionId: '_doc', title: documentTitle(file, source), kind: markdown ? 'markdown' : 'code', language: markdown ? undefined : 'text', version: 1, createdAt: 0, updatedAt: 0, bytes, url: '', path: file };
    return { kind: 'page', html: this.viewerHtml(info, source, `${path.basename(file)} · ${formatBytes(bytes)}`) };
  }

  /** A show_image copy: only the img-<n>.<ext> names, only inside the session's images folder, only image content. */
  private storedImage(sessionId: string, name: string): Resolved | null {
    if (!/^img-\d+\.(png|jpg|webp|gif|svg)$/.test(name)) return null;
    const dir = path.join(this.dirFor(sessionId), 'images');
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return null;
    try {
      // A link planted in the folder does not lead out of it
      if (fs.lstatSync(file).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    const kind = servableImage(file);
    return kind && name.endsWith(`.${kind.ext}`) ? { kind: 'file', path: file } : null;
  }

  private must(session: Session, id: string): ArtifactInfo {
    const info = this.get(session, id);
    if (!info) throw new Error(`No artifact ${id} in this conversation.`);
    return info;
  }

  private nextId(session: Session): string {
    const ids = new Set(Object.keys(session.artifacts ?? {}));
    for (let n = ids.size + 1; ; n++) if (!ids.has(`art-${n}`)) return `art-${n}`;
  }

  private metaPath(sessionId: string): string {
    return path.join(this.dirFor(sessionId), 'meta.json');
  }

  private writeMeta(session: Session): void {
    fs.mkdirSync(this.dirFor(session.id), { recursive: true });
    fs.writeFileSync(this.metaPath(session.id), JSON.stringify(session.artifacts ?? {}));
  }

  private readMeta(sessionId: string): Record<string, ArtifactInfo> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(sessionId), 'utf8')) as Record<string, ArtifactInfo>;
      const dir = this.dirFor(sessionId);
      // Only files inside this session's folder are ever served.
      for (const [id, a] of Object.entries(raw)) if (path.dirname(a.path) !== dir || a.id !== id) delete raw[id];
      return raw;
    } catch {
      return {};
    }
  }
}
