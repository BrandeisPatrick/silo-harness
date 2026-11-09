// The images a session showed (show_image): copies under <userData>/artifacts/<sessionId>/images/img-<n>.<ext>,
// recorded on the session by id (session.images) and served as artifact://view/<session>/images/<file>.

import { nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageInfo } from '../../shared/images';
import { formatBytes } from '../artifacts';
import type { Msg, Session } from '../sessions';
import { imageSize, MAX_IMAGE_BYTES, sniffImage, type ImageKind } from './sniff';

const MAX_IMAGES = 500;
const MAX_CAPTION = 300;
/** What a successful show_image result starts with (toTranscript turns those calls into images) */
export const SHOWN_PREFIX = 'Shown to the user:';

const safeId = (s: string): string | null => (/^[\w-]{1,64}$/.test(s) ? s : null);

export function imagesDir(root: string, sessionId: string): string {
  return path.join(root, safeId(sessionId) ?? 'invalid', 'images');
}

export function imageUrl(sessionId: string, file: string): string {
  return `artifact://view/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(file)}`;
}

/** An absolute path for what the model or a reply named: absolute, ~/…, file://…, or relative to the session's folder. */
export function resolveUserPath(raw: string, cwd: string): string {
  let p = String(raw ?? '').trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      /* left as typed */
    }
  }
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

export interface LoadedImage {
  buf: Buffer;
  kind: ImageKind;
  width?: number;
  height?: number;
}

/** Reads and checks an image file; the error says what is wrong in words the model can act on. */
export function loadImage(file: string, shown = file): LoadedImage {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`no such file: ${shown}`);
  }
  if (st.isDirectory()) throw new Error(`${shown} is a folder, not an image`);
  if (!st.isFile()) throw new Error(`${shown} is not a regular file`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`${path.basename(file)} is too large (${formatBytes(st.size)}); the limit is ${formatBytes(MAX_IMAGE_BYTES)}`);
  if (st.size === 0) throw new Error(`${path.basename(file)} is empty, not an image`);
  const buf = fs.readFileSync(file);
  const kind = sniffImage(buf);
  if (!kind) throw new Error(`${path.basename(file)} is not an image (its content is not PNG, JPEG, WebP, GIF or SVG)`);
  return { buf, kind, ...pixelSize(buf, kind) };
}

/** Electron's decoder when running in the app (it knows every format it can draw), the header otherwise. SVG has none. */
function pixelSize(buf: Buffer, kind: ImageKind): { width?: number; height?: number } {
  if (kind.ext === 'svg') return {};
  try {
    if (typeof nativeImage?.createFromBuffer === 'function') {
      const img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch {
    /* fall back to the header */
  }
  return imageSize(buf, kind) ?? {};
}

/** "512×512, 4.2 KB" (no pixels for SVG) */
export function describeImage(info: Pick<ImageInfo, 'width' | 'height' | 'bytes'>): string {
  const size = formatBytes(info.bytes);
  return info.width && info.height ? `${info.width}×${info.height}, ${size}` : size;
}

/** Copies the image into the session's store and records it. The caller saves the session and emits the event. */
export function storeImage(root: string, session: Session, input: { file: string; source: string; caption?: string }, loaded = loadImage(input.file, input.source)): ImageInfo {
  session.images ??= {};
  if (Object.keys(session.images).length >= MAX_IMAGES) throw new Error(`this conversation already shows ${MAX_IMAGES} images`);
  const dir = imagesDir(root, session.id);
  fs.mkdirSync(dir, { recursive: true });
  const { id, file } = nextName(session, dir, loaded.kind.ext);
  const target = path.join(dir, file);
  fs.writeFileSync(target, loaded.buf);
  const caption = String(input.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION);
  const info: ImageInfo = {
    id,
    sessionId: session.id,
    name: path.basename(input.file),
    mime: loaded.kind.mime,
    bytes: loaded.buf.length,
    createdAt: Date.now(),
    url: imageUrl(session.id, file),
    path: target,
    source: input.source,
  };
  if (caption) info.caption = caption;
  if (loaded.width && loaded.height) {
    info.width = loaded.width;
    info.height = loaded.height;
  }
  session.images[id] = info;
  return info;
}

function nextName(session: Session, dir: string, ext: string): { id: string; file: string } {
  const used = new Set(Object.keys(session.images ?? {}));
  let n = 1;
  for (const id of used) n = Math.max(n, Number(/^img-(\d+)$/.exec(id)?.[1] ?? 0) + 1);
  for (; ; n++) {
    const id = `img-${n}`;
    const file = `${id}.${ext}`;
    if (!used.has(id) && !fs.existsSync(path.join(dir, file))) return { id, file };
  }
}

/** The images of a session, oldest first. */
export function listImages(session: Session | undefined): ImageInfo[] {
  return Object.values(session?.images ?? {}).sort((a, b) => a.createdAt - b.createdAt || idNumber(a.id) - idNumber(b.id));
}

const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

/** A fork gets its own copies, with its own URLs and paths. */
export function copyImages(root: string, from: Session, to: Session): void {
  const list = listImages(from);
  if (!list.length) return;
  const dir = imagesDir(root, to.id);
  fs.mkdirSync(dir, { recursive: true });
  to.images = {};
  for (const img of list) {
    const file = path.basename(img.path);
    const target = path.join(dir, file);
    try {
      fs.copyFileSync(img.path, target);
    } catch {
      continue;
    }
    to.images[img.id] = { ...img, sessionId: to.id, path: target, url: imageUrl(to.id, file) };
  }
}

/** Drops images from the session and their stored copies. */
export function dropImages(session: Session, ids: string[]): void {
  for (const id of ids) {
    const img = session.images?.[id];
    if (!img) continue;
    fs.rmSync(img.path, { force: true });
    delete session.images![id];
  }
  if (session.images && !Object.keys(session.images).length) delete session.images;
}

/**
 * Which stored image each successful show_image call showed, by tool call id. The calls and the images are both in
 * the order they happened, so they pair up in sequence; the path the model named breaks ties (a call whose image
 * is gone is skipped). `messages`: the whole conversation in order, folded messages first.
 */
export function imagesByCall(session: Session, messages: Msg[]): Map<string, ImageInfo> {
  const out = new Map<string, ImageInfo>();
  const images = listImages(session);
  if (!images.length) return out;
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, typeof m.content === 'string' ? m.content : String(m.content));
  let next = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      if (call.type !== 'function' || call.function.name !== 'show_image') continue;
      if (!results.get(call.id)?.startsWith(SHOWN_PREFIX)) continue;
      let source = '';
      try {
        source = String((JSON.parse(call.function.arguments) as { path?: unknown }).path ?? '');
      } catch {
        /* no path to match on */
      }
      let at = images.findIndex((img, i) => i >= next && img.source === source);
      if (at < 0 && images[next] && !images[next].source) at = next;
      if (at < 0) continue;
      out.set(call.id, images[at]);
      next = at + 1;
    }
  }
  return out;
}
