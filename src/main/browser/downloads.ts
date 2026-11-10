// Downloads in the Browser pane. Every download is saved without a dialog, to Settings → Browser's folder (the Mac's
// Downloads folder by default), under a name of our own making: the site's name with path separators, control
// characters and a leading dot stripped, capped at 200 characters ("Do not trust web names", as Playwright says), and
// " (2)", " (3)" added before the extension when the name is taken. The list (the last 50, never their contents) is
// pushed to the window's tray and kept in userData/browser/downloads.json.
//
// Downloads ask unless they are the user's: one that begins within five seconds of the user's own key press or click
// on that tab (the controller knows; the agent's synthetic events do not count), while no browser tool is acting or
// just ended, or from the context menu's Save Image
// As… is the user's and starts at once. Every other one, the agent's or a page's own, is paused at once, kept out of the downloads folder (it goes to a staging
// folder in userData), and the download bar under the URL bar asks "The agent started a download: …" with Allow and
// Don't allow. Allow resumes it and moves it into the folder when it is complete; Don't allow cancels it and removes
// it, so nothing is written where the user keeps their files. The user's own downloads start at once.
//
// The name rules and the agent window are pure: test/browser-downloads.js.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItem, Session, WebContents } from 'electron';
import type { DownloadAction, DownloadState, DownloadStatus } from '../../shared/browser';

/** A saved name is at most this many characters (the extension kept). */
export const NAME_MAX = 200;
/** A download that begins this long after an agent's action ended is still the agent's. */
export const AGENT_TAIL_MS = 2000;
/** How many downloads the list keeps. */
export const KEEP = 50;

const SEPARATORS = /[/\\:]/g;
// C0 and C1 controls, DEL, and the bidirectional overrides a name can hide its real extension with
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** "archive.tar.gz" → { stem: 'archive', ext: '.tar.gz' }; "README" → { stem: 'README', ext: '' } */
export function splitExtension(name: string): { stem: string; ext: string } {
  const m = /^(.+?)((?:\.tar)?\.[A-Za-z0-9]{1,12})$/.exec(name);
  if (!m || /^\.+$/.test(m[1])) return { stem: name, ext: '' };
  return { stem: m[1], ext: m[2] };
}

/**
 * A name from a web page made safe to save: path separators (/, \ and the Finder's :), control characters and
 * direction overrides removed, spaces and dots trimmed from the start (no hidden file, no ".."), at most NAME_MAX
 * characters with the extension kept, and "download" when nothing is left.
 */
export function sanitizeFilename(name: string): string {
  let s = String(name ?? '').normalize('NFC').replace(CONTROLS, '').replace(SEPARATORS, '');
  s = s.replace(/^[\s.]+/, '').replace(/\s+$/, '');
  const chars = [...s];
  if (chars.length > NAME_MAX) {
    const { stem, ext } = splitExtension(s);
    const extChars = [...ext];
    s = extChars.length < 20 ? [...stem].slice(0, NAME_MAX - extChars.length).join('').replace(/\s+$/, '') + ext : chars.slice(0, NAME_MAX).join('');
  }
  // The Mac's limit is 255 bytes; a name of 200 wide characters can be more.
  while (Buffer.byteLength(s, 'utf8') > 250) {
    const { stem, ext } = splitExtension(s);
    s = [...stem].slice(0, -1).join('') + ext;
  }
  return s || 'download';
}

/** `name`, or the first of "name (2).ext", "name (3).ext", … that `taken` says is free. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const { stem, ext } = splitExtension(name);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** A free path for `name` in `dir`: not on disk and not reserved by a download still being written. */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = fs.existsSync, reserved: ReadonlySet<string> = new Set()): string {
  return path.join(dir, uniqueName(name, (c) => reserved.has(path.join(dir, c).toLowerCase()) || exists(path.join(dir, c))));
}

/** The agent's acting, as the controller stamps it: how many of its actions are running, and when the last one ended. */
export interface ActingStamps {
  inFlight: number;
  /** ms since the epoch; 0: never */
  lastEnd: number;
}

/** Whether a download beginning at `now` is the agent's: during one of its actions, or within `tailMs` after one. */
export function startedByAgent(stamps: ActingStamps, now: number, tailMs = AGENT_TAIL_MS): boolean {
  if (stamps.inFlight > 0) return true;
  return stamps.lastEnd > 0 && now >= stamps.lastEnd && now - stamps.lastEnd <= tailMs;
}

/** A download is the user's only this soon after the user's own input on that tab (a key, a click). */
export const USER_INPUT_MS = 5000;

/**
 * Whether a download beginning at `now` is the user's: their own input on its tab (never the agent's synthetic
 * events) came less than `windowMs` before. Anything else, a page that starts a download by itself included, asks.
 */
export function startedByUser(lastUserInput: number | null | undefined, now: number, windowMs = USER_INPUT_MS): boolean {
  const t = Number(lastUserInput) || 0;
  return t > 0 && now >= t && now - t <= windowMs;
}

/**
 * The com.apple.quarantine value a finished download gets, as Safari writes it: flags, the time in hex seconds, the
 * app, an id. Electron's downloads carry none, so Gatekeeper would not check an app or script the user later opens.
 */
export function quarantineValue(now: number, id: string, agent = 'Silo Harness'): string {
  return `0081;${Math.floor(now / 1000).toString(16)};${agent.replace(/;/g, ' ')};${id.toUpperCase()}`;
}

/** Marks a finished download as from the internet (macOS only; a failure is ignored: the file stays as it is). */
export function quarantine(file: string, now = Date.now()): void {
  if (process.platform !== 'darwin' || !file) return;
  execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(now, randomUUID()), file], () => undefined);
}

/** "example.com" or "127.0.0.1:8080" for the list and the bar; '' when the URL has none. */
export function downloadHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return '';
  }
}

const STATES: DownloadStatus[] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted'];

/** The entries of a downloads.json, well-formed; whatever was still running when the app went is interrupted now. */
export function cleanDownloadList(raw: unknown): DownloadState[] {
  if (!Array.isArray(raw)) return [];
  const out: DownloadState[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.filename !== 'string') continue;
    const state = STATES.includes(o.state as DownloadStatus) ? (o.state as DownloadStatus) : 'interrupted';
    const asking = o.asking === true;
    out.push({
      id: o.id,
      filename: o.filename,
      path: typeof o.path === 'string' ? o.path : '',
      url: typeof o.url === 'string' ? o.url : '',
      host: typeof o.host === 'string' ? o.host : '',
      received: Number(o.received) || 0,
      total: Number(o.total) || 0,
      state: asking ? 'cancelled' : state === 'progressing' || state === 'paused' ? 'interrupted' : state,
      startedAt: Number(o.startedAt) || 0,
      byAgent: o.byAgent === true,
      asking: false,
      tabId: null,
    });
  }
  return out.filter((d) => !(d.byAgent && d.state === 'cancelled' && !d.path)).slice(0, KEEP);
}

export function downloadsFile(userData: string): string {
  return path.join(userData, 'browser', 'downloads.json');
}

export interface DownloadHost {
  userData: string;
  /** The folder downloads go to (made when missing) */
  dir(): string;
  /** Where they go when that folder cannot be made (the Mac's Downloads folder) */
  defaultDir(): string;
  /** The controller's stamps (null without a window: nothing is the agent's) */
  stamps(): ActingStamps | null;
  /** The user asked for this address from the context menu (Save Image As…): theirs, whatever the stamps say */
  userStarted?(url: string): boolean;
  /** When the user last pressed a key or clicked in that tab (or one of its popups), ms; 0: not lately */
  userInputAt?(tabId: string | null): number;
  /** The tab a download's contents belong to (a popup's: the tab that opened it) */
  tabOf(wc: WebContents | null): string | null;
  onChange(list: DownloadState[]): void;
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
}

interface Entry {
  state: DownloadState;
  item: DownloadItem | null;
  /** Where an agent's download is written while it waits (userData/browser/pending-downloads/<id>/<name>) */
  staged: string;
  /** How Chromium ended it, once it has */
  done: 'completed' | 'cancelled' | 'interrupted' | null;
}

const ACTIVE = (s: DownloadStatus) => s === 'progressing' || s === 'paused';

/** The pane's downloads: the will-download handler, the list, the tray's and the bar's actions. */
export class DownloadManager {
  private entries: Entry[] = [];
  private pushTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly staging: string;
  private readonly file: string;
  private readonly attached = new WeakSet<Session>();

  constructor(private readonly host: DownloadHost) {
    this.file = downloadsFile(host.userData);
    this.staging = path.join(host.userData, 'browser', 'pending-downloads');
    try {
      this.entries = cleanDownloadList(JSON.parse(fs.readFileSync(this.file, 'utf8'))).map((state) => ({ state, item: null, staged: '', done: null }));
    } catch {
      this.entries = [];
    }
    // What a run that ended without asking left waiting is gone.
    fs.rmSync(this.staging, { recursive: true, force: true });
  }

  attach(ses: Session): void {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    ses.on('will-download', (_event, item, wc) => this.begin(item, wc));
  }

  list(): DownloadState[] {
    return this.entries.map((e) => ({ ...e.state }));
  }

  // ---------- A download begins ----------

  private begin(item: DownloadItem, wc: WebContents | null): void {
    const id = randomUUID();
    const url = item.getURL();
    const filename = sanitizeFilename(item.getFilename());
    const stamps = this.host.stamps();
    const asked = [url, ...(typeof item.getURLChain === 'function' ? item.getURLChain().slice(0, 1) : [])].some((u) => this.host.userStarted?.(u));
    let tabId: string | null = null;
    try {
      tabId = this.host.tabOf(wc);
    } catch {
      tabId = null;
    }
    // The user's only right after their own input on that tab and not while (or just after) the agent acts; everything
    // else asks as the agent's do (no window: nothing asks)
    const now = Date.now();
    const byAgent = stamps && !asked ? !startedByUser(this.host.userInputAt?.(tabId) ?? 0, now) || startedByAgent(stamps, now) : false;
    const entry: Entry = {
      state: { id, filename, path: '', url, host: downloadHost(url), received: 0, total: Math.max(0, item.getTotalBytes()), state: 'progressing', startedAt: Date.now(), byAgent, asking: byAgent, tabId },
      item,
      staged: '',
      done: null,
    };
    if (byAgent) {
      // Out of the user's folder until they answer, and paused (a small file may finish anyway: it waits there).
      const dir = path.join(this.staging, id);
      fs.mkdirSync(dir, { recursive: true });
      entry.staged = path.join(dir, filename);
      item.setSavePath(entry.staged);
      item.pause();
      entry.state.state = 'paused';
    } else {
      const target = this.reserve(filename);
      item.setSavePath(target);
      entry.state.path = target;
      entry.state.filename = path.basename(target);
    }
    item.on('updated', () => this.progress(entry));
    item.once('done', (_e, state) => this.finish(entry, state));
    this.entries.unshift(entry);
    this.trim();
    this.changed(true);
  }

  /** A free path in the downloads folder for `name`. */
  private reserve(name: string): string {
    let dir = this.host.dir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[browser] the downloads folder ${dir} cannot be used (${err instanceof Error ? err.message : String(err)}); saving to the Downloads folder`);
      dir = this.host.defaultDir();
    }
    const reserved = new Set(this.entries.filter((e) => e.state.path && !e.done && ACTIVE(e.state.state)).map((e) => e.state.path.toLowerCase()));
    return uniquePath(dir, name, fs.existsSync, reserved);
  }

  private progress(e: Entry): void {
    if (!e.item || e.done) return;
    e.state.received = e.item.getReceivedBytes();
    e.state.total = Math.max(0, e.item.getTotalBytes());
    if (e.state.asking) e.state.state = 'paused';
    else e.state.state = e.item.getState() === 'interrupted' ? 'interrupted' : e.item.isPaused() ? 'paused' : 'progressing';
    this.changed(false);
  }

  private finish(e: Entry, how: 'completed' | 'cancelled' | 'interrupted'): void {
    e.done = how;
    if (!this.entries.includes(e)) return;
    if (e.item) {
      e.state.received = e.item.getReceivedBytes();
      e.state.total = Math.max(e.state.total, e.item.getTotalBytes());
    }
    if (e.state.asking) {
      // Finished into the staging folder before the user answered: it keeps waiting there, unless it failed.
      if (how === 'completed') e.state.state = 'paused';
      else {
        e.state.asking = false;
        e.state.state = how;
        this.discardStaged(e);
      }
    } else if (e.staged) {
      if (how === 'completed') this.moveIntoFolder(e);
      else {
        e.state.state = how;
        this.discardStaged(e);
      }
    } else {
      e.state.state = how;
      if (how === 'completed') quarantine(e.state.path);
    }
    this.changed(true);
  }

  private moveIntoFolder(e: Entry): void {
    const target = this.reserve(e.state.filename);
    try {
      try {
        fs.renameSync(e.staged, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        fs.copyFileSync(e.staged, target);
        fs.unlinkSync(e.staged);
      }
      e.state.path = target;
      e.state.filename = path.basename(target);
      e.state.state = 'completed';
      quarantine(target);
    } catch (err) {
      console.warn('[browser] could not move a download into the folder:', err instanceof Error ? err.message : String(err));
      e.state.state = 'interrupted';
    }
    this.discardStaged(e);
  }

  private discardStaged(e: Entry): void {
    if (!e.staged) return;
    fs.rmSync(path.dirname(e.staged), { recursive: true, force: true });
    e.staged = '';
  }

  // ---------- The tray and the bar ----------

  /** Open, Show in Finder, Cancel, Clear, and the download bar's Allow and Don't allow. Returns the list after it. */
  async action(id: string, action: DownloadAction): Promise<DownloadState[]> {
    if (action === 'clear') {
      this.entries = this.entries.filter((e) => ACTIVE(e.state.state) || e.state.asking || (id !== '' && e.state.id !== id));
      this.changed(true);
      return this.list();
    }
    const e = this.entries.find((x) => x.state.id === id);
    if (!e) throw new Error('That download is no longer in the list.');
    switch (action) {
      case 'allow':
        this.allow(e);
        break;
      case 'deny':
        this.deny(e);
        break;
      case 'cancel':
        if (e.state.asking) this.deny(e);
        else if (e.item && !e.done) e.item.cancel();
        break;
      case 'open': {
        if (e.state.state !== 'completed' || !e.state.path) throw new Error('Only a finished download can be opened.');
        if (!fs.existsSync(e.state.path)) throw new Error('The file is no longer there.');
        const err = await this.host.openPath(e.state.path);
        if (err) throw new Error(err);
        break;
      }
      case 'show':
        if (!e.state.path) throw new Error('This download was not saved.');
        this.host.showItemInFolder(e.state.path);
        break;
      default:
        throw new Error(`Unknown download action ${String(action)}`);
    }
    return this.list();
  }

  /** Allow: the agent's download goes on, and into the folder once it is complete. */
  private allow(e: Entry): void {
    if (!e.state.asking) return;
    e.state.asking = false;
    if (e.done === 'completed') this.moveIntoFolder(e);
    else if (e.item && !e.done) {
      if (e.item.isPaused() || e.item.canResume()) e.item.resume();
      e.state.state = 'progressing';
    } else e.state.state = e.done ?? 'interrupted';
    this.changed(true);
  }

  /** Don't allow: the agent's download is cancelled and leaves no file and no line in the list. */
  private deny(e: Entry): void {
    e.state.asking = false;
    if (e.item && !e.done) e.item.cancel();
    this.discardStaged(e);
    this.entries = this.entries.filter((x) => x !== e);
    this.changed(true);
  }

  /** At quit: the agent's downloads still waiting are cancelled and the list is saved. */
  quit(): void {
    for (const e of [...this.entries]) if (e.state.asking) this.deny(e);
    this.save();
  }

  /** The newest KEEP entries; one still running is never dropped. */
  private trim(): void {
    if (this.entries.length <= KEEP) return;
    const live = (e: Entry) => ACTIVE(e.state.state) || e.state.asking;
    let room = Math.max(0, KEEP - this.entries.filter(live).length);
    this.entries = this.entries.filter((e) => live(e) || room-- > 0);
  }

  /** A push to the window (now, or within 150 ms while bytes arrive) and a save soon after. */
  private changed(now: boolean): void {
    const push = () => {
      this.pushTimer = null;
      this.host.onChange(this.list());
    };
    if (now) {
      if (this.pushTimer) clearTimeout(this.pushTimer);
      push();
    } else if (!this.pushTimer) this.pushTimer = setTimeout(push, 150);
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, now ? 100 : 1000);
    }
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const list = this.entries.filter((e) => !e.state.asking).map((e) => e.state).slice(0, KEEP);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[browser] could not save the downloads list:', err instanceof Error ? err.message : String(err));
    }
  }
}
