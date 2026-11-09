// Settings → Permissions: the "Always allow … in this project" answers saved for the working directory, as
// removable chips (commands, auto-mode checks, MCP servers) plus the "edits run without asking" row. Removing
// one goes straight to oc.rules (it is not part of the Settings form's Save).
// Also: an in-memory stand-in for oc.rules (the debug hook's mock).

import type { ProjectRules, RulesApi } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { tilde } from './home.js';

export type RuleKind = 'program' | 'reason' | 'edits' | 'mcp';

const uniqueStrings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : [];

/** A well-formed ProjectRules from whatever arrived (missing lists become empty). */
export function cleanRules(r: unknown, cwd = ''): ProjectRules {
  const o = (r && typeof r === 'object' ? r : {}) as Partial<ProjectRules>;
  return {
    cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : cwd,
    programs: uniqueStrings(o.programs),
    reasons: uniqueStrings(o.reasons),
    edits: o.edits === true,
    mcp: uniqueStrings(o.mcp),
  };
}

export function ruleCount(r: ProjectRules): number {
  return r.programs.length + r.reasons.length + r.mcp.length + (r.edits ? 1 : 0);
}

function shortDir(p: string): string {
  return tilde(p).replace(/(.)\/+$/, '$1');
}

export interface RulesPanelElements {
  /** #rules-cwd: the working directory in the section's description */
  cwd: HTMLElement;
  /** #rules-list: the bordered box with the rows */
  list: HTMLElement;
  /** #rules-programs, #rules-reasons, #rules-mcp: the chip containers (each inside a .rules-row) */
  programs: HTMLElement;
  reasons: HTMLElement;
  mcp: HTMLElement;
  /** #rules-edits: the "Edits inside the working directory run without asking" row */
  edits: HTMLElement;
  /** .rules-empty */
  empty: HTMLElement;
  /** #rules-status: why loading or removing failed */
  status: HTMLElement;
}

export interface RulesPanelOptions {
  els: RulesPanelElements;
  /** oc.rules, the debug mock, or null when the running app has no saved rules */
  source: () => RulesApi | null;
  cleanError: (err: unknown) => string;
  /** A rule was removed (the app re-reads its config so Save passes the new allowRules through) */
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

type ListKind = Exclude<RuleKind, 'edits'>;
const LIST_KEY: Record<ListKind, 'programs' | 'reasons' | 'mcp'> = { program: 'programs', reason: 'reasons', mcp: 'mcp' };
const WHAT: Record<RuleKind, string> = { program: 'the command rule', reason: 'the auto-mode rule', mcp: 'the MCP server rule', edits: 'the edits rule' };

export function createRulesPanel(opts: RulesPanelOptions): RulesPanel {
  const { els } = opts;
  let current: ProjectRules | null = null;
  let unavailable = false;
  /** Rules with a removal in flight, as kind:value */
  const busy = new Set<string>();

  const showStatus = (message: string) => {
    els.status.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(message)}</span>`;
    els.status.hidden = false;
  };
  const hideStatus = () => {
    els.status.hidden = true;
    els.status.textContent = '';
  };

  const removeButtons = () => [...els.list.querySelectorAll<HTMLButtonElement>('.rule-remove')].filter((b) => !b.closest('[hidden]'));

  const chip = (kind: ListKind, value: string): HTMLElement => {
    const key = `${kind}:${value}`;
    const el = document.createElement('span');
    el.className = `rule-chip${kind === 'reason' ? '' : ' mono'}${busy.has(key) ? ' busy' : ''}`;
    el.setAttribute('role', 'listitem');
    el.dataset.kind = kind;
    el.dataset.value = value;
    el.innerHTML =
      `<span class="rule-chip-text" title="${escapeHtml(value)}">${escapeHtml(value)}</span>` +
      `<button type="button" class="rule-remove" aria-label="${escapeHtml(`Remove ${value}`)}" title="Remove" data-focus-key="${escapeHtml(key)}">${icon('x', 12)}</button>`;
    const btn = el.querySelector<HTMLButtonElement>('.rule-remove')!;
    if (busy.has(key)) btn.setAttribute('aria-disabled', 'true');
    btn.onclick = () => void remove(kind, value, btn);
    return el;
  };

  const fillList = (box: HTMLElement, kind: ListKind, values: string[]) => {
    box.innerHTML = '';
    for (const v of values) box.appendChild(chip(kind, v));
    const row = box.closest<HTMLElement>('.rules-row');
    if (row) row.hidden = values.length === 0;
  };

  async function remove(kind: RuleKind, value: string | undefined, btn: HTMLButtonElement): Promise<void> {
    const key = `${kind}:${value ?? ''}`;
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
        if (kind === 'edits') rules.edits = false;
        else rules[LIST_KEY[kind]] = rules[LIST_KEY[kind]].filter((v) => v !== value);
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

  const editsBtn = els.edits.querySelector<HTMLButtonElement>('.rule-remove');
  if (editsBtn) editsBtn.onclick = () => void remove('edits', undefined, editsBtn);

  const panel: RulesPanel = {
    render(rules: ProjectRules) {
      current = cleanRules(rules, opts.projectDir());
      const dir = current.cwd || opts.projectDir();
      els.cwd.textContent = dir ? shortDir(dir) : 'this project';
      els.cwd.title = dir;
      fillList(els.programs, 'program', current.programs);
      fillList(els.reasons, 'reason', current.reasons);
      fillList(els.mcp, 'mcp', current.mcp);
      els.edits.hidden = !current.edits;
      els.edits.classList.toggle('busy', busy.has('edits:'));
      editsBtn?.toggleAttribute('aria-disabled', busy.has('edits:'));
      const none = ruleCount(current) === 0;
      els.list.hidden = none;
      els.empty.hidden = !none;
      els.empty.innerHTML = unavailable
        ? `${icon('shield-check', 16)}<p>Restart Silo Harness to see saved rules.</p>`
        : `${icon('shield-check', 16)}<p>No saved rules for this project.</p>`;
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
    resetMessages: hideStatus,
  };
  return panel;
}

// ---------- In-memory stand-in for oc.rules (debug hook) ----------

/** Serves the given rules from memory; removing changes only this copy. */
export function mockRulesSource(initial: ProjectRules, cwd = ''): RulesApi {
  let rules = cleanRules(JSON.parse(JSON.stringify(initial ?? {})), cwd);
  const copy = () => cleanRules(rules, rules.cwd);
  return {
    list: async () => copy(),
    async remove(kind: RuleKind, value?: string) {
      if (kind === 'edits') rules.edits = false;
      else if (kind in LIST_KEY) {
        const k = LIST_KEY[kind as ListKind];
        rules = { ...rules, [k]: rules[k].filter((v) => v !== value) };
      }
      return copy();
    },
  };
}
