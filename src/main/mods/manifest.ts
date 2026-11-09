// mod.json: reading and validating a manifest, exactly as docs/mods.md describes it. Every problem is a sentence a
// person (or the agent writing the mod) can act on, naming the field: "views[0].entry: panel.html does not exist".

import fs from 'node:fs';
import path from 'node:path';
import type { LookKind, ModCommandManifest, ModHookContribution, ModLayout, ModLookManifest, ModLookTarget, ModManifest, ModPermission, ModProblem, ModSeat, ModSettingField, ModViewManifest } from '../../shared/mods';
import { MOD_LOOK_TARGETS, MOD_PERMISSIONS, MOD_SEATS, RESERVED_SEATS } from './permissions';
import { HOOK_EVENTS, OTHER_CLAUDE_EVENTS, isHookEvent } from '../hooks/config';

/** The longest a mod's hook handler may be given (seconds) */
const MOD_HOOK_MAX_TIMEOUT = 600;

export const MOD_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
/** View ids and command names: lower-case letters, digits and -, starting with a letter or digit */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SETTING_KEY_RE = /^[A-Za-z][\w.-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** mod.json larger than this is not read: a manifest is a few kilobytes */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** What a look's or a background's `preview` picture may be */
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];

export interface ManifestResult {
  /** The manifest with only the fields this protocol knows; null when it has problems */
  manifest: ModManifest | null;
  problems: ModProblem[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** True when `p` is inside `dir` (or is `dir`), for already-resolved absolute paths. */
export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why `rel` is not an acceptable path of a file inside the mod, or null when it is: relative, "/"-separated, no "..",
 * no "." segments, no dotfiles, and (once symlinks are resolved) an existing file inside the mod's real folder.
 */
export function modFileProblem(dir: string, rel: unknown, opts: { ext?: string[] } = {}): string | null {
  if (typeof rel !== 'string' || !rel.trim()) return 'must be the path of a file in the mod, e.g. "panel.html"';
  if (rel.includes('\\')) return `${rel} uses "\\"; write paths with "/"`;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) return `${rel} is an absolute path; give a path relative to the mod's folder`;
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) return `${rel} leaves the mod's folder ("..")`;
  if (parts.some((p) => p === '' || p === '.')) return `${rel} has an empty or "." segment`;
  if (parts.some((p) => p.startsWith('.'))) return `${rel} names a hidden file or folder (starting with "."), which is never served`;
  if (opts.ext && !opts.ext.includes(path.extname(rel).toLowerCase())) return `${rel} must be a ${opts.ext.join(' or ')} file`;
  let real: string;
  let root: string;
  try {
    root = fs.realpathSync(dir);
    real = fs.realpathSync(path.join(dir, ...parts));
  } catch {
    return `${rel} does not exist`;
  }
  if (!isInside(root, real)) return `${rel} points outside the mod's folder (a symlink)`;
  try {
    if (!fs.statSync(real).isFile()) return `${rel} is not a file`;
  } catch {
    return `${rel} does not exist`;
  }
  return null;
}

/** Reads <dir>/mod.json and validates it. `folderName` is the name the id must equal (the mod's folder). */
export function readManifest(dir: string, folderName = path.basename(dir)): ManifestResult {
  const file = path.join(dir, 'mod.json');
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fail('mod.json is not a file');
    if (st.size > MAX_MANIFEST_BYTES) return fail(`mod.json is ${Math.round(st.size / 1024)} KB; a manifest must be under ${MAX_MANIFEST_BYTES / 1024} KB`);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fail(`mod.json is missing: create ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return fail(`mod.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateManifest(raw, dir, folderName);
}

function fail(message: string): ManifestResult {
  return { manifest: null, problems: [{ kind: 'manifest', message }] };
}

/** Validates a parsed mod.json against the mod's folder. */
export function validateManifest(raw: unknown, dir: string, folderName = path.basename(dir)): ManifestResult {
  const problems: ModProblem[] = [];
  const bad = (message: string) => problems.push({ kind: 'manifest', message });
  const missing = (message: string) => problems.push({ kind: 'file', message });
  const warn = (message: string) => problems.push({ kind: 'manifest', message, warning: true });
  if (!isObj(raw)) return fail('mod.json must be a JSON object: { "protocol": 1, "id": …, "name": …, "version": … }');

  if (raw.protocol === undefined) bad('protocol: missing; add "protocol": 1');
  else if (raw.protocol !== 1) bad(`protocol: must be 1 (this app speaks protocol 1), found ${JSON.stringify(raw.protocol)}`);

  if (typeof raw.id !== 'string') bad(`id: missing; add "id": "${MOD_ID_RE.test(folderName) ? folderName : 'my-mod'}"`);
  else if (!MOD_ID_RE.test(raw.id)) bad(`id: "${raw.id}" must be 2 to 40 lower-case letters, digits and -, starting with a letter`);
  else if (raw.id !== folderName) bad(`id: "${raw.id}" must equal the folder name "${folderName}" (rename one of them)`);

  if (typeof raw.name !== 'string' || !raw.name.trim()) bad('name: missing; add a short name, e.g. "name": "Word count"');
  if (typeof raw.version !== 'string') bad('version: missing; add "version": "0.1.0"');
  else if (!VERSION_RE.test(raw.version)) bad(`version: "${raw.version}" must be major.minor.patch, e.g. "0.1.0"`);

  for (const k of ['description', 'author', 'homepage', 'license'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') bad(`${k}: must be a string`);
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string' || !raw.icon.trim()) bad('icon: must be a built-in icon name or the path of an SVG file in the mod');
    else if (raw.icon.toLowerCase().endsWith('.svg')) {
      const p = modFileProblem(dir, raw.icon);
      if (p) missing(`icon: ${p}`);
    }
  }

  let permissions: ModPermission[] = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) bad(`permissions: must be a list, e.g. ["session:read"]`);
    else {
      raw.permissions.forEach((p, i) => {
        if (typeof p !== 'string' || !(MOD_PERMISSIONS as readonly string[]).includes(p)) bad(`permissions[${i}]: ${JSON.stringify(p)} is not a permission; use one of ${MOD_PERMISSIONS.join(', ')}`);
        else if (!permissions.includes(p as ModPermission)) permissions.push(p as ModPermission);
      });
    }
  }
  permissions = MOD_PERMISSIONS.filter((p) => permissions.includes(p)); // a stable order, so grants compare simply

  const views: ModViewManifest[] = [];
  const styles: string[] = [];
  const looks: ModLookManifest[] = [];
  const commands: ModCommandManifest[] = [];
  const settings: ModSettingField[] = [];
  let contributes: Record<string, unknown> = {};
  if (raw.contributes !== undefined) {
    if (!isObj(raw.contributes)) bad('contributes: must be an object, e.g. { "views": [ … ] }');
    else contributes = raw.contributes;
  }

  if (contributes.views !== undefined) {
    if (!Array.isArray(contributes.views)) bad('contributes.views: must be a list of views');
    else {
      const ids = new Set<string>();
      contributes.views.forEach((v, i) => {
        const at = `views[${i}]`;
        if (!isObj(v)) return bad(`${at}: must be an object { "id", "title", "entry", "seat" }`);
        let ok = true;
        const no = (m: string) => ((ok = false), bad(m));
        if (typeof v.id !== 'string' || !NAME_RE.test(v.id)) no(`${at}.id: ${v.id === undefined ? 'missing' : JSON.stringify(v.id) + ' is not valid'}; use lower-case letters, digits and -, e.g. "main"`);
        else if (ids.has(v.id)) no(`${at}.id: "${v.id}" is used by another view of this mod`);
        else ids.add(v.id);
        if (typeof v.title !== 'string' || !v.title.trim()) no(`${at}.title: missing; add the title shown on the view's header`);
        if (typeof v.seat !== 'string') no(`${at}.seat: missing; use one of ${MOD_SEATS.join(', ')}`);
        else if (RESERVED_SEATS.includes(v.seat)) no(`${at}.seat: "${v.seat}" is reserved for a later protocol version; use one of ${MOD_SEATS.join(', ')}`);
        else if (!(MOD_SEATS as readonly string[]).includes(v.seat)) no(`${at}.seat: "${v.seat}" is not a seat; use one of ${MOD_SEATS.join(', ')}`);
        const entry = modFileProblem(dir, v.entry, { ext: ['.html', '.htm'] });
        if (entry) {
          ok = false;
          if (/does not exist|is not a file/.test(entry)) missing(`${at}.entry: ${entry}`);
          else bad(`${at}.entry: ${entry}`);
        }
        if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) no(`${at}.order: must be a number`);
        if (v.maxHeight !== undefined && (typeof v.maxHeight !== 'number' || !(v.maxHeight > 0))) no(`${at}.maxHeight: must be a positive number of pixels`);
        if (v.icon !== undefined && (typeof v.icon !== 'string' || !v.icon.trim())) no(`${at}.icon: must be a built-in icon name or an SVG file in the mod`);
        else if (typeof v.icon === 'string' && v.icon.toLowerCase().endsWith('.svg')) {
          const p = modFileProblem(dir, v.icon);
          if (p) ((ok = false), missing(`${at}.icon: ${p}`));
        }
        if (v.preview !== undefined) {
          const p = modFileProblem(dir, v.preview, { ext: PREVIEW_EXT });
          if (p) ((ok = false), /does not exist|is not a file/.test(p) ? missing(`${at}.preview: ${p}`) : bad(`${at}.preview: ${p}`));
        }
        if (!ok) return;
        const view: ModViewManifest = { id: v.id as string, title: (v.title as string).trim(), entry: v.entry as string, seat: v.seat as ModSeat };
        if (v.order !== undefined) view.order = v.order as number;
        if (v.maxHeight !== undefined) view.maxHeight = v.maxHeight as number;
        if (v.icon !== undefined) view.icon = v.icon as string;
        if (v.preview !== undefined) view.preview = v.preview as string;
        views.push(view);
      });
    }
  }

  if (contributes.styles !== undefined) {
    if (!Array.isArray(contributes.styles)) bad('contributes.styles: must be a list of CSS files, e.g. ["theme.css"]');
    else {
      contributes.styles.forEach((s, i) => {
        const p = modFileProblem(dir, s, { ext: ['.css'] });
        if (p) return /does not exist|is not a file/.test(p) ? missing(`styles[${i}]: ${p}`) : bad(`styles[${i}]: ${p}`);
        if (!styles.includes(s as string)) styles.push(s as string);
      });
    }
  }

  if (contributes.looks !== undefined) {
    if (!Array.isArray(contributes.looks)) bad('contributes.looks: must be a list of looks, e.g. [{ "id": "main", "title": "…", "target": "conversation", "styles": ["look.css"] }]');
    else {
      const lookIds = new Set<string>();
      contributes.looks.forEach((l, i) => {
        const at = `looks[${i}]`;
        if (!isObj(l)) return bad(`${at}: must be an object { "id", "title", "target", "styles" }`);
        let ok = true;
        const no = (m: string) => ((ok = false), bad(m));
        if (typeof l.id !== 'string' || !NAME_RE.test(l.id)) no(`${at}.id: ${l.id === undefined ? 'missing' : JSON.stringify(l.id) + ' is not valid'}; use lower-case letters, digits and -, e.g. "main"`);
        else if (lookIds.has(l.id)) no(`${at}.id: "${l.id}" is used by another look of this mod`);
        else lookIds.add(l.id);
        if (typeof l.title !== 'string' || !l.title.trim()) no(`${at}.title: missing; add the name shown in Settings, Mods`);
        if (l.description !== undefined && typeof l.description !== 'string') no(`${at}.description: must be a string`);
        if (l.preview !== undefined) {
          const p = modFileProblem(dir, l.preview, { ext: PREVIEW_EXT });
          if (p) ((ok = false), /does not exist|is not a file/.test(p) ? missing(`${at}.preview: ${p}`) : bad(`${at}.preview: ${p}`));
        }
        const files: string[] = [];
        if (!Array.isArray(l.styles) || !l.styles.length) no(`${at}.styles: must be a non-empty list of CSS files in the mod, e.g. ["look.css"]`);
        else {
          l.styles.forEach((f, j) => {
            const p = modFileProblem(dir, f, { ext: ['.css'] });
            if (p) return ((ok = false), /does not exist|is not a file/.test(p) ? missing(`${at}.styles[${j}]: ${p}`) : bad(`${at}.styles[${j}]: ${p}`));
            if (!files.includes(f as string)) files.push(f as string);
          });
        }
        // A target this app does not know (a later one) is skipped with a warning, so the rest of the mod still loads.
        if (typeof l.target !== 'string') return no(`${at}.target: missing; use one of ${MOD_LOOK_TARGETS.join(', ')}`);
        if (!(MOD_LOOK_TARGETS as readonly string[]).includes(l.target)) {
          if (ok) warn(`${at}.target: "${l.target}" is not a region this version of the app knows (${MOD_LOOK_TARGETS.join(', ')}), so this look is ignored`);
          return;
        }
        if (!ok) return;
        const look: ModLookManifest = { id: l.id as string, title: (l.title as string).trim(), target: l.target as ModLookTarget, styles: files };
        if (typeof l.description === 'string') look.description = l.description;
        if (typeof l.preview === 'string') look.preview = l.preview;
        looks.push(look);
      });
    }
  }

  if (contributes.commands !== undefined) {
    if (!Array.isArray(contributes.commands)) bad('contributes.commands: must be a list of commands');
    else {
      const names = new Set<string>();
      contributes.commands.forEach((c, i) => {
        const at = `commands[${i}]`;
        if (!isObj(c)) return bad(`${at}: must be an object { "name", "description" }`);
        let ok = true;
        const no = (m: string) => ((ok = false), bad(m));
        const name = typeof c.name === 'string' ? c.name.replace(/^\//, '') : c.name;
        if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) no(`${at}.name: ${name === undefined ? 'missing' : JSON.stringify(name) + ' is not valid'}; use lower-case letters, digits and -, starting with a letter (without the slash)`);
        else if (names.has(name)) no(`${at}.name: "/${name}" is defined twice`);
        else names.add(name);
        if (typeof c.description !== 'string' || !c.description.trim()) no(`${at}.description: missing; say in a few words what the command does`);
        if (c.view !== undefined && (typeof c.view !== 'string' || !ids(contributes.views).includes(c.view))) no(`${at}.view: ${JSON.stringify(c.view)} is not the id of a view of this mod`);
        if (!ok) return;
        const cmd: ModCommandManifest = { name: name as string, description: (c.description as string).trim() };
        if (c.view !== undefined) cmd.view = c.view as string;
        commands.push(cmd);
      });
    }
  }

  if (contributes.settings !== undefined) {
    if (!Array.isArray(contributes.settings)) bad('contributes.settings: must be a list of fields');
    else {
      const keys = new Set<string>();
      contributes.settings.forEach((f, i) => {
        const field = settingField(f, `settings[${i}]`, keys, bad);
        if (field) settings.push(field);
      });
    }
  }

  const hooks: ModHookContribution[] = [];
  if (contributes.hooks !== undefined) {
    if (!Array.isArray(contributes.hooks)) bad('contributes.hooks: must be a list of hook events, e.g. ["PreToolUse", "Stop"]');
    else {
      if (contributes.hooks.length && !permissions.includes('hooks')) bad('contributes.hooks: handling hooks needs the "hooks" permission; add it to "permissions"');
      const seen = new Set<string>();
      contributes.hooks.forEach((e, i) => {
        const at = `hooks[${i}]`;
        const entry = typeof e === 'string' ? { event: e } : isObj(e) ? e : null;
        if (!entry) return bad(`${at}: must be an event name or { "event": "PreToolUse", "timeout": 30 }`);
        const event = entry.event;
        if (typeof event !== 'string') return bad(`${at}.event: missing; use one of ${HOOK_EVENTS.join(', ')}`);
        // An event this app does not fire (one of Claude Code's, or a later one) is skipped, so the mod still loads.
        if (!isHookEvent(event)) return warn(`${at}: "${event}" is ${OTHER_CLAUDE_EVENTS.includes(event) ? 'a Claude Code event this app does not fire' : 'not a hook event this version of the app knows'}, so it is ignored (fired: ${HOOK_EVENTS.join(', ')})`);
        if (seen.has(event)) return bad(`${at}: "${event}" is listed twice`);
        seen.add(event);
        const h: ModHookContribution = { event };
        if (entry.timeout !== undefined) {
          if (typeof entry.timeout !== 'number' || !Number.isFinite(entry.timeout) || entry.timeout <= 0 || entry.timeout > MOD_HOOK_MAX_TIMEOUT) return bad(`${at}.timeout: must be a number of seconds from 1 to ${MOD_HOOK_MAX_TIMEOUT}`);
          h.timeout = entry.timeout;
        }
        hooks.push(h);
      });
    }
  }

  if (problems.some((p) => !p.warning)) return { manifest: null, problems };
  const r = raw as Record<string, unknown>;
  const manifest: ModManifest = { protocol: 1, id: r.id as string, name: (r.name as string).trim(), version: r.version as string };
  for (const k of ['description', 'author', 'homepage', 'license', 'icon'] as const) if (typeof r[k] === 'string') manifest[k] = r[k] as string;
  if (permissions.length) manifest.permissions = permissions;
  const c: NonNullable<ModManifest['contributes']> = {};
  if (views.length) c.views = views;
  if (styles.length) c.styles = styles;
  if (looks.length) c.looks = looks;
  if (commands.length) c.commands = commands;
  if (settings.length) c.settings = settings;
  if (hooks.length) c.hooks = hooks;
  if (Object.keys(c).length) manifest.contributes = c;
  return { manifest, problems };
}

function ids(views: unknown): string[] {
  return Array.isArray(views) ? views.flatMap((v) => (isObj(v) && typeof v.id === 'string' ? [v.id] : [])) : [];
}

function settingField(f: unknown, at: string, keys: Set<string>, bad: (m: string) => void): ModSettingField | null {
  if (!isObj(f)) return bad(`${at}: must be an object { "key", "type", "title" }`), null;
  let ok = true;
  const no = (m: string) => ((ok = false), bad(m));
  if (typeof f.key !== 'string' || !SETTING_KEY_RE.test(f.key)) no(`${at}.key: ${f.key === undefined ? 'missing' : JSON.stringify(f.key) + ' is not valid'}; use letters, digits, _ . -, starting with a letter`);
  else if (keys.has(f.key)) no(`${at}.key: "${f.key}" is used by another setting`);
  else keys.add(f.key);
  if (typeof f.title !== 'string' || !f.title.trim()) no(`${at}.title: missing; add the label shown in Settings`);
  if (f.description !== undefined && typeof f.description !== 'string') no(`${at}.description: must be a string`);
  const base = { key: f.key as string, title: typeof f.title === 'string' ? f.title.trim() : '', ...(typeof f.description === 'string' ? { description: f.description } : {}) };
  const num = (k: string) => f[k] === undefined || (typeof f[k] === 'number' && Number.isFinite(f[k] as number)) || (no(`${at}.${k}: must be a number`), false);
  switch (f.type) {
    case 'boolean':
      if (f.default !== undefined && typeof f.default !== 'boolean') no(`${at}.default: must be true or false for a boolean setting`);
      return ok ? { ...base, type: 'boolean', ...(f.default !== undefined ? { default: f.default as boolean } : {}) } : null;
    case 'string':
      if (f.default !== undefined && typeof f.default !== 'string') no(`${at}.default: must be a string for a string setting`);
      if (f.placeholder !== undefined && typeof f.placeholder !== 'string') no(`${at}.placeholder: must be a string`);
      return ok ? { ...base, type: 'string', ...(f.default !== undefined ? { default: f.default as string } : {}), ...(f.placeholder !== undefined ? { placeholder: f.placeholder as string } : {}) } : null;
    case 'number': {
      const fine = num('min') && num('max') && num('step');
      if (fine && f.step !== undefined && !((f.step as number) > 0)) no(`${at}.step: must be greater than 0`);
      if (fine && f.min !== undefined && f.max !== undefined && (f.min as number) > (f.max as number)) no(`${at}: min is greater than max`);
      if (f.default !== undefined) {
        if (typeof f.default !== 'number' || !Number.isFinite(f.default)) no(`${at}.default: must be a number for a number setting`);
        else if (fine && ((f.min !== undefined && f.default < (f.min as number)) || (f.max !== undefined && f.default > (f.max as number)))) no(`${at}.default: ${f.default} is outside min/max`);
      }
      if (!ok) return null;
      const out: ModSettingField = { ...base, type: 'number' };
      for (const k of ['default', 'min', 'max', 'step'] as const) if (f[k] !== undefined) out[k] = f[k] as number;
      return out;
    }
    case 'select': {
      const opts = f.options;
      if (!Array.isArray(opts) || !opts.length || opts.some((o) => typeof o !== 'string' || !o)) no(`${at}.options: must be a non-empty list of strings`);
      else if (new Set(opts).size !== opts.length) no(`${at}.options: has the same option twice`);
      if (f.default !== undefined && (typeof f.default !== 'string' || !Array.isArray(opts) || !opts.includes(f.default))) no(`${at}.default: must be one of the options`);
      return ok ? { ...base, type: 'select', options: [...(opts as string[])], ...(f.default !== undefined ? { default: f.default as string } : {}) } : null;
    }
    default:
      no(`${at}.type: ${f.type === undefined ? 'missing' : JSON.stringify(f.type) + ' is not a type'}; use boolean, string, number or select`);
      return null;
  }
}

/** Whether the manifest contributes something that needs the "styles" approval: CSS for the app, a look, or a background. */
export function needsStylesApproval(m: ModManifest | null): boolean {
  return !!m && (!!m.contributes?.styles?.length || !!m.contributes?.looks?.length || !!m.contributes?.views?.some((v) => v.seat === 'background'));
}

/**
 * Whether a mod has parts behind a switch: a view in the rail, the side pane, the composer strip or the worker seat,
 * or a slash command. A mod with none is only looks (backgrounds, looks, a theme): it has no switch.
 */
export function hasFeatureParts(m: ModManifest | null | undefined): boolean {
  const c = m?.contributes;
  return !!c && ((c.views ?? []).some((v) => v.seat !== 'background') || (c.commands ?? []).length > 0);
}

/** Whether a mod has looks: a background view, a look for a region, or styles (a theme). */
export function hasLookParts(m: ModManifest | null | undefined): boolean {
  const c = m?.contributes;
  return !!c && ((c.views ?? []).some((v) => v.seat === 'background') || (c.looks ?? []).length > 0 || (c.styles ?? []).length > 0);
}

/** The mod key and the part id in "<mod key>/<id>" (a project mod's key holds "/" itself, so the last one splits). */
export function splitRef(ref: string): { key: string; id: string } | null {
  const i = ref.lastIndexOf('/');
  return i > 0 && i < ref.length - 1 ? { key: ref.slice(0, i), id: ref.slice(i + 1) } : null;
}

/** A mod's first look of each kind, as the layout names it ("<key>/<id>", or the key for its theme); null where it has none. */
export function lookPartsOf(key: string, m: ModManifest | null | undefined): Record<LookKind, string | null> {
  const c = m?.contributes ?? {};
  const look = (t: ModLookTarget) => {
    const l = (c.looks ?? []).find((x) => x.target === t);
    return l ? `${key}/${l.id}` : null;
  };
  const bg = (c.views ?? []).find((v) => v.seat === 'background');
  return { background: bg ? `${key}/${bg.id}` : null, composer: look('composer'), conversation: look('conversation'), theme: (c.styles ?? []).length ? key : null };
}

/** Whether `ref` names a part of kind `kind` of the mod `key` with manifest `m`. */
export function isPartOf(kind: LookKind, ref: string, key: string, m: ModManifest | null | undefined): boolean {
  const c = m?.contributes;
  if (!c) return false;
  if (kind === 'theme') return ref === key && (c.styles ?? []).length > 0;
  const at = splitRef(ref);
  if (!at || at.key !== key) return false;
  if (kind === 'background') return (c.views ?? []).some((v) => v.id === at.id && v.seat === 'background');
  return (c.looks ?? []).some((l) => l.id === at.id && l.target === kind);
}

/** The ref the layout has in use for a kind ("image" for the user's picture counts as no mod's). */
export function layoutRef(layout: Partial<ModLayout> | null | undefined, kind: LookKind): string | null {
  if (!layout) return null;
  if (kind === 'theme') return layout.theme ?? null;
  if (kind === 'background') return layout.background ?? null;
  return layout.looks?.[kind] ?? null;
}

/** The kinds of look of mod `key` that the layout has in use. */
export function inUseKinds(key: string, m: ModManifest | null | undefined, layout: Partial<ModLayout> | null | undefined): LookKind[] {
  return LOOK_KINDS.filter((k) => {
    const ref = layoutRef(layout, k);
    return !!ref && isPartOf(k, ref, key, m);
  });
}

/** The kinds of look, in the order of the tabs of Settings → Mods */
export const LOOK_KINDS: readonly LookKind[] = ['background', 'composer', 'conversation', 'theme'];

/** Whether `value` fits a setting field (type, options, range). */
export function settingFits(field: ModSettingField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string' && value.length <= 10_000;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
    case 'select':
      return typeof value === 'string' && field.options.includes(value);
  }
}

/** Defaults from the manifest, then the stored values that still fit. */
export function settingValues(m: ModManifest | null, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of m?.contributes?.settings ?? []) {
    if (f.default !== undefined) out[f.key] = f.default;
    else out[f.key] = f.type === 'boolean' ? false : f.type === 'number' ? (f.min ?? 0) : f.type === 'select' ? f.options[0] : '';
    const v = stored?.[f.key];
    if (v !== undefined && settingFits(f, v)) out[f.key] = v;
  }
  return out;
}
