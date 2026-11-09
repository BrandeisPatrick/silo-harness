// The mod registry: finds mods in the three roots (bundled, user, project), validates them, works out each one's
// state from what is stored in config.mods, and watches the folders so edits show up live.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModInfo, ModManifest, ModPermission, ModProblem, ModScope, ModsConfig } from '../../shared/mods';
import { MOD_ID_RE, hasFeatureParts, hasLookParts, inUseKinds, needsStylesApproval, readManifest, settingValues } from './manifest';

export const MOD_SCHEME = 'mod';
const MAX_RUNTIME_PROBLEMS = 20;
const REV_MAX_FILES = 4000;
const REV_MAX_DEPTH = 12;
const DEBOUNCE_MS = 150;
const MISSING_ROOT_POLL_MS = 1500;

/** A path inside an asar archive (the packaged app's own files) */
const inArchive = (dir: string): boolean => /\.asar(?:[\\/]|$)/.test(dir);

export interface RegistryOptions {
  /** <appRoot>/mods */
  bundledRoot: string;
  /** <configDir>/mods (read on every scan, so a test can move it) */
  userRoot: () => string;
  /** The project folder (the working directory); its mods are in <project>/.silo-harness/mods */
  projectDir: () => string;
  /** <project>/.silo-harness/mods for a project folder */
  projectRoot: (projectDir: string) => string;
  mods: () => ModsConfig;
  /** The list changed (after a scan that found a difference) */
  onChange?: (list: ModInfo[]) => void;
  /** A mod that is not on appeared, or now asks for something new: show the card (once per key and wanted set) */
  onOffer?: (info: ModInfo) => void;
}

/** What the registry keeps per mod folder between scans. */
interface Entry {
  key: string;
  id: string;
  scope: ModScope;
  dir: string;
  label: string;
  /** The last manifest that validated in this app run */
  manifest: ModManifest | null;
  problems: ModProblem[];
  rev: string;
}

/** 8 hex characters naming a project folder in mod origins. */
export function projectHash(dir: string): string {
  return createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
}

export function modLabel(id: string, scope: ModScope, projectDir?: string): string {
  return scope === 'project' ? `${id}.p-${projectHash(projectDir ?? '')}` : `${id}.${scope}`;
}

export function modKey(id: string, scope: ModScope, projectDir?: string): string {
  return scope === 'project' ? `${id}@${path.resolve(projectDir ?? '')}` : id;
}

/**
 * Changes whenever a file of the mod changes: a hash of relative paths, sizes and mtimes. Dotfiles (.git and the
 * like) are skipped; a huge folder is hashed up to a cap rather than walked for ever.
 */
export function modRev(dir: string): string {
  const h = createHash('sha1');
  let files = 0;
  const walk = (abs: string, rel: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < REV_MAX_DEPTH && !walk(p, r, depth + 1)) return false;
        continue;
      }
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        h.update(`${r}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
      } catch {
        continue;
      }
      if (++files >= REV_MAX_FILES) {
        h.update('…partial');
        return false;
      }
    }
    return true;
  };
  walk(dir, '', 0);
  return h.digest('hex').slice(0, 12);
}

export class ModRegistry {
  private entries = new Map<string, Entry>();
  private infos: ModInfo[] = [];
  private runtime = new Map<string, ModProblem[]>();
  private offered = new Set<string>();
  private scanned = false;
  private watchers = new Map<string, fs.FSWatcher>();
  /** Roots whose watch failed and was reported: the poll keeps trying them, without saying so again */
  private unwatched = new Set<string>();
  private poll: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watching = false;
  private lastJson = '';

  constructor(private readonly opts: RegistryOptions) {}

  /** The three roots, in the order mods override each other's listing (bundled is hidden by a user mod with its id) */
  roots(): { scope: ModScope; dir: string }[] {
    const project = this.opts.projectDir();
    const out: { scope: ModScope; dir: string }[] = [
      { scope: 'bundled', dir: this.opts.bundledRoot },
      { scope: 'user', dir: this.opts.userRoot() },
    ];
    // With the home folder as the working directory the project's .silo-harness is the user folder: list those mods once.
    const projectRoot = project ? this.opts.projectRoot(project) : '';
    if (projectRoot && path.resolve(projectRoot) !== path.resolve(out[1].dir)) out.push({ scope: 'project', dir: projectRoot });
    return out;
  }

  list(): ModInfo[] {
    return this.infos;
  }

  get(key: string): ModInfo | undefined {
    return this.infos.find((m) => m.key === key);
  }

  /** The mod served on an origin label ("word-count.user"), whatever its state */
  byLabel(label: string): ModInfo | undefined {
    for (const e of this.entries.values()) if (e.label === label) return this.get(e.key);
    return undefined;
  }

  /** The origin label of a listed mod */
  labelOf(key: string): string | undefined {
    return this.entries.get(key)?.label;
  }

  /** A page's uncaught error, kept (the last 20 per mod) until the app quits */
  report(key: string, problem: Omit<ModProblem, 'kind'>): void {
    const list = this.runtime.get(key) ?? [];
    list.push({ kind: 'runtime', ...problem });
    while (list.length > MAX_RUNTIME_PROBLEMS) list.shift();
    this.runtime.set(key, list);
    this.recompute();
  }

  runtimeProblems(key: string): ModProblem[] {
    return this.runtime.get(key) ?? [];
  }

  /** Re-reads every root and returns the new list; tells onChange when it differs from the last one. */
  scan(): ModInfo[] {
    const seen = new Map<string, Entry>();
    const project = this.opts.projectDir();
    for (const root of this.roots()) {
      let names: fs.Dirent[] = [];
      try {
        names = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (d.name.startsWith('.')) continue;
        const dir = path.join(root.dir, d.name);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const id = d.name;
        const key = modKey(id, root.scope, project);
        if (root.scope === 'user' && seen.get(key)?.scope === 'bundled') seen.delete(key); // the user's copy replaces it
        const prev = this.entries.get(key);
        const label = modLabel(id, root.scope, project);
        const r = readManifest(dir, id);
        const keepPrev = prev && prev.dir === dir && prev.scope === root.scope;
        // A broken edit keeps the last manifest that validated, so a half-written mod.json does not blank a panel.
        const manifest = r.manifest ?? (keepPrev ? prev.manifest : null);
        const problems = MOD_ID_RE.test(id) || r.problems.length ? r.problems : [{ kind: 'manifest' as const, message: `the folder name "${id}" is not a valid mod id` }];
        seen.set(key, { key, id, scope: root.scope, dir, label, manifest, problems, rev: modRev(dir) });
      }
    }
    for (const k of this.runtime.keys()) if (!seen.has(k)) this.runtime.delete(k);
    this.entries = seen;
    this.recompute();
    return this.infos;
  }

  /** Rebuilds the list from what is known (after a config change: no disk access). */
  recompute(): ModInfo[] {
    const cfg = this.opts.mods();
    const infos: ModInfo[] = [];
    const bundledIds = new Set([...this.entries.values()].filter((e) => e.scope === 'bundled').map((e) => e.id));
    for (const e of this.entries.values()) infos.push(this.info(e, cfg, e.scope === 'user' && this.hadBundled(e.id, bundledIds)));
    const order: Record<ModScope, number> = { bundled: 0, user: 1, project: 2 };
    infos.sort((a, b) => order[a.scope] - order[b.scope] || a.id.localeCompare(b.id));
    this.infos = infos;
    this.offers(cfg);
    this.scanned = true;
    const json = JSON.stringify(infos);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.opts.onChange?.(infos);
    }
    return infos;
  }

  /** Whether a user mod hides a bundled one (the bundled folder exists with that id) */
  private hadBundled(id: string, bundledIds: Set<string>): boolean {
    if (bundledIds.has(id)) return true;
    try {
      return fs.statSync(path.join(this.opts.bundledRoot, id)).isDirectory();
    } catch {
      return false;
    }
  }

  private info(e: Entry, cfg: ModsConfig, overrides: boolean): ModInfo {
    const m = e.manifest;
    const asked: ModPermission[] = m?.permissions ?? [];
    const features = hasFeatureParts(m);
    const looks = hasLookParts(m);
    const covers = (have: unknown) => Array.isArray(have) && asked.every((p) => have.includes(p));
    let state: ModInfo['state'];
    let granted: ModPermission[] = [];
    let wants: ModPermission[] = [];
    let wantsStyles = false;
    // The looks: a bundled mod's need no approval; a user or project mod's, the one given at their first Use.
    const approval = e.scope === 'bundled' ? null : cfg.approved?.[e.key];
    const approved = !!m && looks && (e.scope === 'bundled' || (!!approval && covers(approval.permissions) && !cfg.safeMode));
    const inUse = m && looks ? inUseKinds(e.key, m, cfg.layout) : [];
    if (!m) state = 'invalid';
    else if (!features) {
      // Only looks: no switch. On while one of them is in use (and may apply), paused while one is in use and it asks
      // for more than was approved, off otherwise.
      if (e.scope === 'bundled') granted = [...asked];
      else {
        const have = approval?.permissions ?? [];
        granted = approval ? asked.filter((p) => have.includes(p)) : [];
        wants = asked.filter((p) => !have.includes(p));
        wantsStyles = !approval;
      }
      state = !inUse.length ? 'off' : approved ? 'on' : approval && !cfg.safeMode ? 'paused' : 'off';
    } else if (e.scope === 'bundled') {
      const off = (cfg.disabledBundled ?? []).includes(e.id);
      state = off ? 'off' : 'on';
      granted = off ? [] : [...asked];
    } else {
      const grant = cfg.enabled?.[e.key];
      wantsStyles = looks && !approval;
      if (!grant) {
        state = 'off';
        wants = [...asked];
        if (approved) granted = asked.filter((p) => approval!.permissions.includes(p));
      } else {
        const have = Array.isArray(grant.permissions) ? grant.permissions : [];
        // Only what the manifest still asks for and the user approved is in effect.
        granted = asked.filter((p) => have.includes(p));
        wants = asked.filter((p) => !have.includes(p));
        state = cfg.safeMode ? 'off' : wants.length ? 'paused' : 'on';
        if (state !== 'on') granted = approved ? asked.filter((p) => approval!.permissions.includes(p)) : granted;
      }
    }
    const info: ModInfo = {
      key: e.key,
      id: e.id,
      scope: e.scope,
      dir: e.dir,
      manifest: m,
      state,
      granted,
      wants,
      wantsStyles,
      problems: [...e.problems, ...this.runtimeProblems(e.key)],
      rev: e.rev,
      origin: `${MOD_SCHEME}://${e.label}`,
      settings: settingValues(m, cfg.settings?.[e.key]),
    };
    if (looks) {
      info.approved = approved;
      info.inUse = inUse;
    }
    if (overrides) info.overrides = true;
    return info;
  }

  /** The cards: a mod that is not on and was not offered with this set of wants in this run. The first scan only records. */
  private offers(cfg: ModsConfig): void {
    for (const info of this.infos) {
      if (info.scope === 'bundled' || info.state === 'invalid' || !info.manifest) continue;
      const sig = `${info.key}|${(info.manifest.permissions ?? []).join(',')}|${needsStylesApproval(info.manifest)}`;
      if (this.offered.has(sig)) continue;
      this.offered.add(sig);
      // An on mod's set is recorded too, so turning it off later does not bring the card straight back.
      if (info.state !== 'on' && this.scanned && !cfg.safeMode) this.opts.onOffer?.(info);
    }
  }

  /** Marks what the list shows now as already offered (after the user turned a mod off, say) */
  markOffered(): void {
    for (const info of this.infos) {
      if (!info.manifest) continue;
      this.offered.add(`${info.key}|${(info.manifest.permissions ?? []).join(',')}|${needsStylesApproval(info.manifest)}`);
    }
  }

  // ---------- Watching ----------

  /** Watches the three roots (recursive, debounced). A root that does not exist yet is picked up when it appears. */
  watch(): void {
    this.watching = true;
    this.rewatch();
    if (!this.poll) {
      this.poll = setInterval(() => this.attachMissing(), MISSING_ROOT_POLL_MS);
      this.poll.unref?.();
    }
  }

  /** Re-targets the watchers (the working directory changed) */
  rewatch(): void {
    if (!this.watching) return;
    const want = new Set(this.roots().map((r) => r.dir));
    for (const [dir, w] of this.watchers) {
      if (!want.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    this.attachMissing();
  }

  private attachMissing(): void {
    for (const { dir } of this.roots()) {
      // The built-in mods of a packaged app sit inside its archive: nothing there can be watched, and nothing changes.
      if (this.watchers.has(dir) || inArchive(dir)) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const w = fs.watch(dir, { recursive: true }, () => this.changed());
        this.unwatched.delete(dir);
        w.on('error', () => {
          w.close();
          if (this.watchers.get(dir) === w) this.watchers.delete(dir);
          this.changed();
        });
        this.watchers.set(dir, w);
        this.changed(); // it just appeared (or was re-created): its contents count as a change
      } catch (err) {
        if (!this.unwatched.has(dir)) console.warn('[mods] cannot watch', dir, err);
        this.unwatched.add(dir);
      }
    }
  }

  private changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.scan();
      } catch (err) {
        console.warn('[mods] rescan failed:', err);
      }
    }, DEBOUNCE_MS);
  }

  close(): void {
    this.watching = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.poll) clearInterval(this.poll);
    if (this.timer) clearTimeout(this.timer);
    this.poll = null;
    this.timer = null;
  }
}

