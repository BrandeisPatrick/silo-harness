// Settings → Permissions: the project's permission rules (Allow, Ask, Deny, and the auto-mode checks that no longer
// pause) as removable chips, a field that adds one, and the global rules of the user's settings.json, read-only.
// Adding and removing go straight to oc.rules (not part of the Settings form's Save).
// Also: an in-memory stand-in for oc.rules (the debug hook's mock).

import type { ProjectRules, RuleEntry, RuleList, RulesApi } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { tilde } from './home.js';

export type RuleKind = RuleList | 'reason';

const LISTS: RuleList[] = ['allow', 'ask', 'deny'];

const entries = (v: unknown): RuleEntry[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: RuleEntry[] = [];
  for (const x of v) {
    const e = typeof x === 'string' ? { text: x } : x && typeof x === 'object' && typeof (x as RuleEntry).text === 'string' ? (x as RuleEntry) : null;
    if (!e || !e.text.trim() || seen.has(e.text)) continue;
    seen.add(e.text);
    out.push(typeof e.error === 'string' && e.error ? { text: e.text, error: e.error } : { text: e.text });
  }
  return out;
};
const uniqueStrings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : [];

/** A well-formed ProjectRules from whatever arrived (missing lists become empty). */
export function cleanRules(r: unknown, cwd = ''): ProjectRules {
  const o = (r && typeof r === 'object' ? r : {}) as Partial<ProjectRules>;
  const g = (o.global && typeof o.global === 'object' ? o.global : {}) as Partial<ProjectRules['global']>;
  return {
    cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : cwd,
    allow: entries(o.allow),
    ask: entries(o.ask),
    deny: entries(o.deny),
    reasons: uniqueStrings(o.reasons),
    global: { file: typeof g.file === 'string' ? g.file : '', allow: entries(g.allow), ask: entries(g.ask), deny: entries(g.deny) },
  };
}

export function ruleCount(r: ProjectRules): number {
  return r.allow.length + r.ask.length + r.deny.length + r.reasons.length;
}

function shortDir(p: string): string {
  return tilde(p).replace(/(.)\/+$/, '$1');
}

export interface RulesPanelElements {
  /** #rules-cwd: the working directory above the list */
  cwd: HTMLElement;
  /** #rules-list: the bordered box with the project's rows */
  list: HTMLElement;
  /** #rules-allow, #rules-ask, #rules-deny, #rules-reasons: the chip containers (each inside a .rules-row) */
  allow: HTMLElement;
  ask: HTMLElement;
  deny: HTMLElement;
  reasons: HTMLElement;
  /** .rules-empty */
  empty: HTMLElement;
  /** The add field: the list, the rule, the button, and why the rule would be refused */
  addList: HTMLSelectElement;
  addInput: HTMLInputElement;
  addBtn: HTMLButtonElement;
  addError: HTMLElement;
  /** #rules-global-for (with #rules-global-file) and #rules-global: the settings.json rules */
  globalFor: HTMLElement;
  globalFile: HTMLElement;
  global: HTMLElement;
  /** #rules-ignored: the rules that do not parse, one line each */
  ignored: HTMLElement;
  /** #rules-status: why loading, adding or removing failed */
  status: HTMLElement;
}

export interface RulesPanelOptions {
  els: RulesPanelElements;
  /** oc.rules, the debug mock, or null when the running app has no saved rules */
  source: () => RulesApi | null;
  cleanError: (err: unknown) => string;
  /** A rule was added or removed (the app re-reads its config so Save passes the new allowRules through) */
  onMutated?: () => void;
  /** The working directory to show before the first list arrives */
  projectDir: () => string;
}

export interface RulesPanel {
  render(rules: ProjectRules): void;
  /** Reloads from the source; null when that failed or there is no source */
  refresh(): Promise<ProjectRules | null>;
  rules(): ProjectRules | null;
  /** Clears the error left from last time (Settings opened again) */
  resetMessages(): void;
}

const WHAT: Record<RuleKind, string> = { allow: 'the allow rule', ask: 'the ask rule', deny: 'the deny rule', reason: 'the auto-mode rule' };

export function createRulesPanel(opts: RulesPanelOptions): RulesPanel {
  const { els } = opts;
  let current: ProjectRules | null = null;
  let unavailable = false;
  /** Rules with a removal in flight, as kind:value */
  const busy = new Set<string>();
  let adding = false;
  let checkSeq = 0;

  const showStatus = (message: string) => {
    els.status.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
    els.status.hidden = false;
  };
  const hideStatus = () => {
    els.status.hidden = true;
    els.status.textContent = '';
  };
  const showAddError = (message: string | null) => {
    els.addError.hidden = !message;
    els.addError.innerHTML = message ? `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>` : '';
    els.addInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  };

  const removeButtons = () => [...els.list.querySelectorAll<HTMLButtonElement>('.rule-remove')].filter((b) => !b.closest('[hidden]'));

  const chip = (kind: RuleKind, e: RuleEntry, removable: boolean): HTMLElement => {
    const key = `${kind}:${e.text}`;
    const el = document.createElement('span');
    el.className = `rule-chip${kind === 'reason' ? '' : ' mono'}${busy.has(key) ? ' busy' : ''}${e.error ? ' invalid' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.kind = kind;
    el.dataset.value = e.text;
    const title = e.error ? `Ignored: ${e.error}` : e.text;
    el.innerHTML =
      (e.error ? icon('triangle-alert', 12) : '') +
      `<span class="rule-chip-text" title="${escapeHtml(title)}">${escapeHtml(e.text)}</span>` +
      (removable ? `<button type="button" class="rule-remove" aria-label="${escapeHtml(`Remove ${e.text}`)}" title="Remove" data-focus-key="${escapeHtml(key)}">${icon('x', 12)}</button>` : '');
    const btn = el.querySelector<HTMLButtonElement>('.rule-remove');
    if (btn) {
      if (busy.has(key)) btn.setAttribute('aria-disabled', 'true');
      btn.onclick = () => void remove(kind, e.text, btn);
    }
    return el;
  };

  const fillList = (box: HTMLElement, kind: RuleKind, values: RuleEntry[], removable: boolean) => {
    box.innerHTML = '';
    for (const v of values) box.appendChild(chip(kind, v, removable));
    const row = box.closest<HTMLElement>('.rules-row');
    if (row) row.hidden = values.length === 0;
  };

  async function remove(kind: RuleKind, value: string, btn: HTMLButtonElement): Promise<void> {
    const key = `${kind}:${value}`;
    if (busy.has(key) || !current) return;
    const api = opts.source();
    if (!api || typeof api.remove !== 'function') {
      showStatus(`Couldn't remove ${WHAT[kind]}. Restart Silo Harness and try again.`);
      return;
    }
    const focusAt = document.activeElement === btn ? removeButtons().indexOf(btn) : -1;
    busy.add(key);
    panel.render(current);
    try {
      const next = await api.remove(kind, value);
      busy.delete(key);
      hideStatus();
      let rules: ProjectRules;
      if (next && typeof next === 'object') rules = cleanRules(next, current.cwd);
      else {
        // An answer without the list: drop the rule locally.
        rules = cleanRules(current, current.cwd);
        if (kind === 'reason') rules.reasons = rules.reasons.filter((v) => v !== value);
        else rules[kind] = rules[kind].filter((v) => v.text !== value);
      }
      panel.render(rules);
      opts.onMutated?.();
      if (focusAt >= 0) {
        const buttons = removeButtons();
        // The next rule's ×, else the dialog itself (so Esc and ⌘W keep working).
        (buttons[Math.min(focusAt, buttons.length - 1)] ?? els.list.closest<HTMLElement>('dialog'))?.focus({ preventScroll: true });
      }
    } catch (err) {
      busy.delete(key);
      panel.render(current);
      showStatus(`Couldn't remove ${WHAT[kind]}: ${opts.cleanError(err)}`);
    }
  }

  const addList = (): RuleList => (LISTS.includes(els.addList.value as RuleList) ? (els.addList.value as RuleList) : 'allow');

  /** Checks the rule as it is typed: the button is off and the reason shows while it would be refused */
  async function validate(): Promise<string | null> {
    const text = els.addInput.value.trim();
    const seq = ++checkSeq;
    if (!text) {
      showAddError(null);
      els.addBtn.disabled = true;
      return 'empty';
    }
    const api = opts.source();
    let error: string | null = null;
    try {
      error = api && typeof api.check === 'function' ? await api.check(addList(), text) : null;
    } catch (err) {
      error = opts.cleanError(err);
    }
    if (seq !== checkSeq) return error;
    showAddError(error);
    els.addBtn.disabled = !!error;
    return error;
  }

  async function add(): Promise<void> {
    if (adding) return;
    const text = els.addInput.value.trim();
    if (!text) return;
    const api = opts.source();
    if (!api || typeof api.add !== 'function') {
      showAddError('Restart Silo Harness to add rules.');
      return;
    }
    if (await validate()) return;
    adding = true;
    els.addBtn.classList.add('busy');
    try {
      const next = await api.add(addList(), text);
      els.addInput.value = '';
      showAddError(null);
      els.addBtn.disabled = true;
      panel.render(cleanRules(next, current?.cwd ?? opts.projectDir()));
      opts.onMutated?.();
    } catch (err) {
      showAddError(opts.cleanError(err));
    } finally {
      adding = false;
      els.addBtn.classList.remove('busy');
    }
  }

  els.addInput.addEventListener('input', () => void validate());
  els.addList.addEventListener('change', () => void validate());
  els.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void add();
    }
  });
  els.addBtn.onclick = () => void add();
  els.addBtn.disabled = true;

  const panel: RulesPanel = {
    render(rules: ProjectRules) {
      current = cleanRules(rules, opts.projectDir());
      const dir = current.cwd || opts.projectDir();
      els.cwd.textContent = dir ? shortDir(dir) : 'this project';
      els.cwd.title = dir;
      for (const list of LISTS) fillList(els[list], list, current[list], true);
      fillList(els.reasons, 'reason', current.reasons.map((text) => ({ text })), true);
      const none = ruleCount(current) === 0;
      els.list.hidden = none;
      els.empty.hidden = !none;
      els.empty.innerHTML = unavailable
        ? `${icon('shield-check', 16)}<p>Restart Silo Harness to see saved rules.</p>`
        : `${icon('shield-check', 16)}<p>No rules for this project.</p>`;
      // The settings.json rules: read-only (the file is yours to edit)
      const g = current.global;
      const globalCount = g.allow.length + g.ask.length + g.deny.length;
      for (const list of LISTS) fillList(els.global.querySelector<HTMLElement>(`[data-list="${list}"]`)!, list, g[list], false);
      els.global.hidden = globalCount === 0;
      els.globalFor.hidden = globalCount === 0;
      els.globalFile.textContent = g.file ? shortDir(g.file) : 'settings.json';
      els.globalFile.title = g.file;
      const bad = [...LISTS.flatMap((l) => current![l]), ...LISTS.flatMap((l) => g[l])].filter((e) => e.error);
      els.ignored.hidden = bad.length === 0;
      els.ignored.innerHTML = bad.map((e) => `<span>Ignored <code>${escapeHtml(e.text)}</code>: ${escapeHtml(e.error!)}</span>`).join('<br>');
    },
    async refresh() {
      const api = opts.source();
      unavailable = !api || typeof api.list !== 'function';
      if (!api || unavailable) {
        panel.render(cleanRules(null, opts.projectDir()));
        return null;
      }
      try {
        const rules = cleanRules(await api.list(), opts.projectDir());
        panel.render(rules);
        return rules;
      } catch (err) {
        panel.render(current ?? cleanRules(null, opts.projectDir()));
        showStatus(`Couldn't load the saved rules: ${opts.cleanError(err)}`);
        return null;
      }
    },
    rules: () => (current ? cleanRules(current, current.cwd) : null),
    resetMessages: () => {
      hideStatus();
      showAddError(null);
    },
  };
  return panel;
}

// ---------- In-memory stand-in for oc.rules (debug hook) ----------

/**
 * Serves the given rules from memory; adding and removing change only this copy. Its check refuses what does not
 * look like Tool or Tool(specifier) (the real check is the main process's).
 */
export function mockRulesSource(initial: ProjectRules, cwd = ''): RulesApi {
  let rules = cleanRules(JSON.parse(JSON.stringify(initial ?? {})), cwd);
  const copy = () => cleanRules(rules, rules.cwd);
  const problem = (text: string) => (/^[A-Za-z_][\w.-]*(\(.+\))?$/s.test(text.trim()) ? null : 'write Tool or Tool(specifier)');
  return {
    list: async () => copy(),
    async remove(kind: RuleKind, value: string) {
      if (kind === 'reason') rules = { ...rules, reasons: rules.reasons.filter((v) => v !== value) };
      else if (LISTS.includes(kind)) rules = { ...rules, [kind]: rules[kind].filter((v) => v.text !== value) };
      return copy();
    },
    async add(list: RuleList, text: string) {
      const why = problem(text);
      if (why) throw new Error(why);
      rules = { ...rules, [list]: [...rules[list].filter((e) => e.text !== text.trim()), { text: text.trim() }] };
      return copy();
    },
    check: async (_list: RuleList, text: string) => problem(text),
  };
}
