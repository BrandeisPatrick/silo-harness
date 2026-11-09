// Images in the assistant's replies: the figures show_image puts into the transcript, local Markdown images
// (![alt](./shot.png)) resolved through the main process, and the thumbnails on tool rows and their groups.
// Wired from renderer.ts under // [feature:images]; everything else arrives through the bus and the item registry.

import type { ImageInfo } from '../shared/images';
import { bus } from './bus.js';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { rpc } from './rpc.js';
import { appendTranscriptItem, registerTranscriptItem } from './transcript-items.js';

export interface ImageViewDeps {
  /** The transcript (#messages) */
  messages: HTMLElement;
  openLightbox(src: string, name?: string, caption?: string): void;
  showError(anchor: HTMLElement, message: string): void;
}

/** The box a figure is fitted into; images are never scaled up. */
export const FIT_W = 420;
export const FIT_H = 320;
/** A group row shows this many thumbnails, then "+N" */
const GROUP_THUMBS = 3;

export function fitBox(width: number, height: number, maxW = FIT_W, maxH = FIT_H): { width: number; height: number } {
  const s = Math.min(1, maxW / width, maxH / height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

let deps: ImageViewDeps | null = null;

export function setupImageView(d: ImageViewDeps): void {
  deps = d;
  registerTranscriptItem('image', (item) => {
    const img = (item as { image?: ImageInfo }).image;
    return img && typeof img.url === 'string' ? placeFigure(createFigure(img)) : null;
  });
  bus.on('agent-event', (ev, _sessionId, onScreen) => {
    if (onScreen && ev.type === 'image' && ev.image) appendTranscriptItem({ role: 'image', image: ev.image });
  });
  // Relative paths in Markdown belong to the session's folder
  bus.on('session-shown', () => resolved.clear());
  d.messages.addEventListener('click', onClick);
  new MutationObserver(onMutations).observe(d.messages, { childList: true, subtree: true });
}

// ---------- Figures ----------

function createFigure(img: ImageInfo): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'reply-image';
  fig.dataset.imageId = img.id;
  fig.dataset.sessionId = img.sessionId;
  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'reply-image-frame';
  frame.setAttribute('aria-label', `Open ${img.name}`);
  const el = document.createElement('img');
  el.alt = img.caption || img.name;
  el.draggable = false;
  el.decoding = 'async';
  if (img.width && img.height) {
    // The box is reserved before the image arrives, so the transcript does not jump.
    const box = fitBox(img.width, img.height);
    frame.style.width = `${box.width}px`;
    frame.style.aspectRatio = `${img.width} / ${img.height}`;
    el.width = box.width;
    el.height = box.height;
  } else fig.classList.add('unsized');
  el.src = img.url;
  el.addEventListener('error', () => fig.classList.add('broken'), { once: true });
  frame.appendChild(el);
  frame.addEventListener('click', () => deps?.openLightbox(img.url, img.name, img.caption || img.name));
  const tools = document.createElement('div');
  tools.className = 'reply-image-tools';
  tools.innerHTML =
    `<button type="button" class="icon-btn sm" data-act="copy" aria-label="Copy image" data-tip="Copy image">${icon('copy', 14)}</button>` +
    `<button type="button" class="icon-btn sm" data-act="save" aria-label="Save as…" data-tip="Save as…">${icon('download', 14)}</button>` +
    `<button type="button" class="icon-btn sm" data-act="reveal" aria-label="Reveal in Finder" data-tip="Reveal in Finder">${icon('folder', 14)}</button>`;
  tools.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (b) void act(img, b.dataset.act ?? '', b, el);
  });
  fig.append(frame, tools);
  if (img.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = img.caption;
    fig.appendChild(cap);
  }
  return fig;
}

/** Consecutive images share a row: a figure joins the row right before it, or starts one. */
function placeFigure(fig: HTMLElement): HTMLElement | null {
  const messages = deps?.messages;
  let last = messages?.lastElementChild as HTMLElement | null;
  // A show_image call's own row stays hidden (and goes once it succeeds); it does not break a run of images.
  while (last && last.hidden && last.classList.contains('tool')) last = last.previousElementSibling as HTMLElement | null;
  if (messages && last?.classList.contains('reply-images')) {
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 64;
    last.appendChild(fig);
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    return null;
  }
  const row = document.createElement('div');
  row.className = 'reply-images';
  row.appendChild(fig);
  return row;
}

async function act(img: ImageInfo, what: string, button: HTMLButtonElement, el: HTMLImageElement): Promise<void> {
  try {
    if (what === 'copy') {
      const ok = (await rpc('images.copy', img.id, img.sessionId)) || (await copyThroughCanvas(el));
      if (!ok) throw new Error("this image can't be copied, use Save as… instead");
      flash(button);
    } else if (what === 'save') {
      if (await rpc('images.saveAs', img.id, img.sessionId)) flash(button);
    } else if (what === 'reveal') {
      await rpc('images.reveal', img.id, img.sessionId);
    }
  } catch (err) {
    const verb = what === 'copy' ? 'copy' : what === 'save' ? 'save' : 'reveal';
    deps?.showError(button, `Couldn't ${verb} the image: ${cleanError(err)}`);
  }
}

/** For what the system cannot decode: the image as drawn in the window, as a PNG. False when the canvas is not readable. */
async function copyThroughCanvas(el: HTMLImageElement): Promise<boolean> {
  try {
    if (!el.complete || !el.naturalWidth) return false;
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    canvas.getContext('2d')!.drawImage(el, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

function flash(button: HTMLButtonElement): void {
  button.classList.add('done');
  const was = button.innerHTML;
  button.innerHTML = icon('check', 14);
  window.setTimeout(() => {
    button.classList.remove('done');
    button.innerHTML = was;
  }, 1200);
}

function cleanError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error:\s*)+/, '');
  return /No handler registered/.test(msg) ? 'this needs the updated app. Restart Silo Harness.' : msg;
}

// ---------- Clicks: thumbnails and Markdown images open the lightbox ----------

function onClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const thumb = t.closest<HTMLImageElement>('img.tool-thumb, img.md-img');
  if (thumb) {
    // A thumbnail sits in a row's summary: open the image, not the row
    e.preventDefault();
    e.stopPropagation();
    deps?.openLightbox(thumb.src, thumb.alt);
  }
}

// ---------- Mutations: Markdown placeholders and group thumbnails ----------

type Resolution = { url: string; name: string } | { error: string };
const resolved = new Map<string, Resolution | Promise<Resolution>>();

function onMutations(records: MutationRecord[]): void {
  const groups = new Set<HTMLElement>();
  let placeholders = false;
  for (const r of records) {
    const target = r.target as HTMLElement;
    const g = target.closest?.<HTMLElement>('.tool-group');
    if (g) groups.add(g);
    for (const n of r.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.classList.contains('tool-group')) groups.add(n);
      else n.querySelectorAll<HTMLElement>('.tool-group').forEach((x) => groups.add(x));
      if (n.classList.contains('md-img-pending') || n.querySelector('.md-img-pending')) placeholders = true;
    }
  }
  for (const g of groups) syncGroupThumbs(g);
  if (placeholders) hydrateMarkdownImages();
}

/** The thumbnails of the images inside a group row, in its summary line: at most three, then "+N". */
function syncGroupThumbs(group: HTMLElement): void {
  const summary = group.querySelector<HTMLElement>(':scope > summary');
  if (!summary) return;
  const thumbs = [...group.querySelectorAll<HTMLImageElement>(':scope > .group-body > .tool > summary img.tool-thumb')];
  const sig = thumbs.map((t) => t.src.length + ':' + t.src.slice(-24)).join('|');
  let box = summary.querySelector<HTMLElement>(':scope > .group-thumbs');
  if ((box?.dataset.sig ?? '') === sig) return;
  if (!thumbs.length) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement('span');
    box.className = 'group-thumbs';
    summary.appendChild(box);
  }
  box.dataset.sig = sig;
  box.innerHTML = '';
  for (const t of thumbs.slice(0, GROUP_THUMBS)) {
    const im = document.createElement('img');
    im.className = 'tool-thumb';
    im.src = t.src;
    im.alt = t.alt;
    im.title = 'Open the image';
    im.draggable = false;
    box.appendChild(im);
  }
  if (thumbs.length > GROUP_THUMBS) box.insertAdjacentHTML('beforeend', `<span class="thumb-more">+${thumbs.length - GROUP_THUMBS}</span>`);
}

/** Placeholders the Markdown renderer left for local images: ask the main process, then show the image or a quiet chip. */
function hydrateMarkdownImages(): void {
  const root = deps?.messages;
  if (!root) return;
  for (const ph of root.querySelectorAll<HTMLElement>('.md-img-pending:not([data-state])')) {
    const src = ph.dataset.src ?? '';
    let r = resolved.get(src);
    if (!r) {
      r = rpc('images.resolve', src).catch((err: unknown): Resolution => ({ error: cleanError(err) }));
      resolved.set(src, r);
      void r.then((v) => resolved.set(src, v));
    }
    if (r instanceof Promise) {
      ph.dataset.state = 'loading';
      void r.then((v) => ph.isConnected && settle(ph, v));
    } else settle(ph, r);
  }
}

function settle(ph: HTMLElement, r: Resolution): void {
  const alt = ph.dataset.alt ?? '';
  if ('url' in r) {
    const img = document.createElement('img');
    img.className = 'md-img';
    img.src = r.url;
    img.alt = alt || r.name;
    img.title = ph.title || alt || r.name;
    img.draggable = false;
    img.addEventListener('error', () => img.replaceWith(missingChip(alt || r.name)), { once: true });
    ph.replaceWith(img);
  } else ph.replaceWith(missingChip(alt || ph.dataset.src || 'image'));
}

function missingChip(alt: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'md-img-missing';
  chip.innerHTML = `${icon('image', 14)}<span>${escapeHtml(`image not found: ${alt}`)}</span>`;
  return chip;
}
