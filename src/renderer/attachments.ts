// Image attachments: pasted, dropped or picked images are decoded, scaled so the long side is at most
// 1568 px and re-encoded (PNG for PNG/GIF, JPEG for the rest) before they go to the model; plus the
// composer's row of 56px thumbnails.

import type { ImageAttachment } from '../shared/types';
import { escapeHtml, formatBytes } from './dom.js';
import { icon } from './icons.js';

export const MAX_ATTACHMENTS = 8;
export const MAX_SIDE = 1568;
export const MAX_BYTES = 4 * 1024 * 1024;

export interface ImageLimits {
  /** Longest side in pixels after scaling */
  maxSide: number;
  /** Largest encoded size in bytes */
  maxBytes: number;
}

export const DEFAULT_LIMITS: ImageLimits = { maxSide: MAX_SIDE, maxBytes: MAX_BYTES };

const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** A problem with one image, worded for the inline error next to the paperclip. */
export class AttachError extends Error {}

/** The attachable image type of a file (by its MIME type, else its extension), or '' when it is not one. */
export function imageType(file: { type?: string; name?: string }): string {
  const type = (file.type ?? '').toLowerCase();
  if (ACCEPTED.has(type)) return type;
  if (type === 'image/jpg' || type === 'image/pjpeg') return 'image/jpeg';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? '';
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `img-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** "photo.jpg · 1024×768 · 230 KB" */
export function attachmentLabel(a: Pick<ImageAttachment, 'name' | 'width' | 'height' | 'size'>): string {
  return `${a.name} · ${a.width}×${a.height} · ${formatBytes(a.size)}`;
}

/** Decodes a data: URL without fetch (the page's CSP does not allow fetching data: URLs). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/is.exec(dataUrl.trim());
  if (!m) throw new AttachError('That is not a data: URL.');
  const mime = (m[1] || 'text/plain').toLowerCase();
  if (!m[3]) return new Blob([decodeURIComponent(m[4])], { type: mime });
  let bin: string;
  try {
    bin = atob(m[4].replace(/\s+/g, ''));
  } catch {
    throw new AttachError('The data: URL is not valid base64.');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** createImageBitmap first (GIFs give their first frame); an <img> on a data: URL when that fails. */
async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width > 0 && bmp.height > 0) return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      bmp.close();
    } catch {
      /* fall back to an <img> */
    }
  }
  const url = await blobToDataUrl(blob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
}

function encode(src: Decoded, width: number, height: number, mime: 'image/png' | 'image/jpeg', quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new AttachError('Could not process the image.'));
  // JPEG has no alpha: transparent areas become white instead of black.
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new AttachError('Could not encode the image.'))), mime, quality);
  });
}

/**
 * Turns an image file into an attachment: scaled so the long side is at most `maxSide`, PNG for PNG and GIF
 * (first frame), JPEG 0.9 otherwise; re-encoded as JPEG 0.8 when that is over `maxBytes`, rejected when still over.
 */
export async function processImage(blob: Blob, name: string, limits: ImageLimits = DEFAULT_LIMITS): Promise<ImageAttachment> {
  const label = name || 'Image';
  const type = imageType({ type: blob.type, name });
  if (!type) throw new AttachError(`${label} is not a PNG, JPEG, WebP or GIF image.`);
  let decoded: Decoded;
  try {
    decoded = await decode(blob);
  } catch {
    throw new AttachError(`Couldn't read ${label} as an image.`);
  }
  try {
    const scale = Math.min(1, limits.maxSide / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const lossless = type === 'image/png' || type === 'image/gif';
    let out = await encode(decoded, width, height, lossless ? 'image/png' : 'image/jpeg', 0.9);
    if (out.size > limits.maxBytes) out = await encode(decoded, width, height, 'image/jpeg', 0.8);
    if (out.size > limits.maxBytes) {
      throw new AttachError(`${label} is too large: ${formatBytes(out.size)} after compressing, the limit is ${formatBytes(limits.maxBytes)}.`);
    }
    const mime = out.type || (lossless ? 'image/png' : 'image/jpeg');
    return { id: newId(), name: label, mime, dataUrl: await blobToDataUrl(out), width, height, size: out.size };
  } finally {
    decoded.close();
  }
}

// ---------- The composer's thumbnail row ----------

export interface ImageInput {
  blob: Blob;
  name: string;
}

export interface AddResult {
  added: ImageAttachment[];
  /** One message per image that could not be attached */
  errors: string[];
}

export interface AttachmentTray {
  /** Ready attachments, in order */
  items(): ImageAttachment[];
  /** Images still being processed */
  pending(): number;
  /** Processes and appends images (at most MAX_ATTACHMENTS in all) */
  add(inputs: ImageInput[], limits?: ImageLimits): Promise<AddResult>;
  /** Appends attachments that were already processed (a dropped queued message coming back); returns how many did not fit */
  restore(list: ImageAttachment[]): number;
  remove(id: string): void;
  /** Removes the given attachments (all when omitted) */
  clear(ids?: string[]): void;
  /** Resolves once nothing is being processed */
  idle(): Promise<void>;
}

export interface AttachmentTrayOptions {
  /** #attachments */
  root: HTMLElement;
  /** After anything was added or removed */
  onChange: () => void;
  /** A thumbnail was clicked */
  onPreview: (a: ImageAttachment) => void;
  /** Focus goes back to the composer after a thumbnail was removed with the keyboard */
  onFocusComposer: () => void;
}

export function createAttachmentTray(opts: AttachmentTrayOptions): AttachmentTray {
  const { root } = opts;
  let items: ImageAttachment[] = [];
  let pending = 0;
  let idleWaiters: (() => void)[] = [];

  const settle = () => {
    if (pending > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const thumb = (a: ImageAttachment): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'attachment';
    el.dataset.id = a.id;
    const label = attachmentLabel(a);
    el.innerHTML =
      `<button type="button" class="attach-thumb" aria-label="${escapeHtml(`Preview ${label}`)}" data-tip="${escapeHtml(label)}"><img alt="" draggable="false"></button>` +
      `<button type="button" class="attach-remove" aria-label="${escapeHtml(`Remove ${a.name}`)}" data-tip="Remove">${icon('x', 12)}</button>`;
    el.querySelector('img')!.src = a.dataUrl;
    const open = el.querySelector<HTMLButtonElement>('.attach-thumb')!;
    open.onclick = () => opts.onPreview(a);
    open.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      e.preventDefault();
      const all = [...root.querySelectorAll<HTMLElement>('.attachment:not(.pending) .attach-thumb')];
      const next = all[all.indexOf(open) + 1] ?? all[all.indexOf(open) - 1];
      tray.remove(a.id);
      if (next?.isConnected) next.focus();
      else opts.onFocusComposer();
    });
    el.querySelector<HTMLButtonElement>('.attach-remove')!.onclick = (e) => {
      e.stopPropagation();
      tray.remove(a.id);
      opts.onFocusComposer();
    };
    return el;
  };

  const placeholder = (name: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'attachment pending';
    el.dataset.tip = `Processing ${name}…`;
    el.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `Processing ${name}`);
    return el;
  };

  const sync = () => {
    root.hidden = items.length === 0 && pending === 0;
    opts.onChange();
  };

  const tray: AttachmentTray = {
    items: () => items.slice(),
    pending: () => pending,
    async add(inputs: ImageInput[], limits?: ImageLimits): Promise<AddResult> {
      const result: AddResult = { added: [], errors: [] };
      const room = Math.max(0, MAX_ATTACHMENTS - items.length - pending);
      const accepted = inputs.slice(0, room);
      if (inputs.length > room) {
        const extra = inputs.length - room;
        result.errors.push(
          room === 0
            ? `A message can have up to ${MAX_ATTACHMENTS} images.`
            : `A message can have up to ${MAX_ATTACHMENTS} images, ${extra} left out.`,
        );
      }
      if (!accepted.length) return result;
      // Placeholders keep the order the images were given in while they are processed one by one.
      const slots = accepted.map((input) => {
        const el = placeholder(input.name || 'image');
        root.appendChild(el);
        return el;
      });
      pending += accepted.length;
      sync();
      for (let i = 0; i < accepted.length; i++) {
        const slot = slots[i];
        try {
          const a = await processImage(accepted[i].blob, accepted[i].name, limits);
          pending -= 1;
          if (slot.isConnected) {
            items.push(a);
            // Keep the list in on-screen order (an earlier slot may have been removed meanwhile)
            slot.replaceWith(thumb(a));
            const order = [...root.querySelectorAll<HTMLElement>('.attachment[data-id]')].map((n) => n.dataset.id);
            items.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
            result.added.push(a);
          }
        } catch (err) {
          pending -= 1;
          slot.remove();
          result.errors.push(err instanceof AttachError ? err.message : `Couldn't attach ${accepted[i].name || 'the image'}.`);
        }
        sync();
      }
      settle();
      return result;
    },
    restore(list: ImageAttachment[]): number {
      const room = Math.max(0, MAX_ATTACHMENTS - items.length - pending);
      const candidates = list.filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl && !items.some((x) => x.id === a.id));
      const fits = candidates.slice(0, room);
      for (const a of fits) {
        items.push(a);
        root.appendChild(thumb(a));
      }
      sync();
      return candidates.length - fits.length;
    },
    remove(id: string) {
      const i = items.findIndex((a) => a.id === id);
      if (i < 0) return;
      items.splice(i, 1);
      root.querySelector(`.attachment[data-id="${CSS.escape(id)}"]`)?.remove();
      sync();
    },
    clear(ids?: string[]) {
      const drop = ids ? new Set(ids) : null;
      items = items.filter((a) => {
        if (drop && !drop.has(a.id)) return true;
        root.querySelector(`.attachment[data-id="${CSS.escape(a.id)}"]`)?.remove();
        return false;
      });
      sync();
    },
    idle(): Promise<void> {
      if (pending === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
  root.hidden = true;
  return tray;
}
