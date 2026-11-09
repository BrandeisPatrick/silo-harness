// Dreaming in the window: the dreams as the main process last sent them, and the proposal cards that read them, in a
// dream's transcript (a registered transcript item) and in Settings → Dreaming. A card shows what is proposed, why,
// the sessions it came from (links that open them), a preview and its state, with Apply, Dismiss or Revert.

import type { Dream, DreamingState, DreamProposal } from '../shared/dreaming';
import { h } from './dom.js';
import { icon, type IconName } from './icons.js';
import { lineDiff, renderDiff, type DiffRow } from './diff.js';
import { tilde } from './home.js';
import { onPush, rpc } from './rpc.js';
import { registerTranscriptItem, appendTranscriptItem } from './transcript-items.js';

/** The tools that make a proposal (the same list as src/main/dreaming/names.ts; test/dreaming.js checks it) */
export const PROPOSAL_TOOLS = ['propose_skill', 'propose_memory', 'propose_mod'];
/** A proposal id as the tools' results name it */
export const PROPOSAL_ID_RE = /\bproposal (pr_[0-9a-f]{6,})\b/;

export interface DreamingDeps {
  /** Brings a session on screen */
  openSession(id: string): void;
  /** A session's title, when the window knows it */
  sessionTitle(id: string): string | undefined;
  showError(anchor: HTMLElement, message: string): void;
  cleanError(err: unknown): string;
}

let deps: DreamingDeps | null = null;
let current: DreamingState | null = null;
const listeners = new Set<(s: DreamingState) => void>();
/** Proposal id → the cards on the page that show it */
const cards = new Map<string, Set<(p: DreamProposal | undefined) => void>>();

export function dreamingState(): DreamingState | null {
  return current;
}

/** Follows every change (the cache is filled before the callback runs). */
export function onDreaming(cb: (s: DreamingState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function proposalById(id: string): DreamProposal | undefined {
  for (const d of current?.dreams ?? []) {
    const p = d.proposals.find((x) => x.id === id);
    if (p) return p;
  }
  return undefined;
}

export function adoptDreaming(s: DreamingState | null | undefined): void {
  if (!s || typeof s !== 'object' || !Array.isArray(s.dreams)) return;
  current = s;
  for (const [id, set] of cards) {
    const p = proposalById(id);
    for (const update of set) update(p);
  }
  for (const cb of [...listeners]) cb(s);
}

/** Re-reads the state from the main process (after an action, or on start). */
export async function refreshDreaming(): Promise<DreamingState | null> {
  try {
    adoptDreaming(await rpc('dreaming.get'));
  } catch {
    /* the feature is absent */
  }
  return current;
}

// ---------- Words ----------

const KIND: Record<DreamProposal['kind'], { label: string; icon: IconName }> = {
  skill: { label: 'Skill', icon: 'sparkles' },
  memory: { label: 'Memory', icon: 'file-text' },
  mod: { label: 'Mod', icon: 'puzzle' },
};

export const STATE_WORDS: Record<DreamProposal['state'], string> = {
  waiting: 'Waiting for you',
  planned: 'In the plan',
  applied: 'Applied',
  dismissed: 'Dismissed',
  withdrawn: 'Withdrawn',
  reverted: 'Reverted',
  failed: 'Failed',
};

/** "Waiting for you · 3", "Plan ready · 2", "Applied 2 of 3", "Nothing to suggest", "Failed: …" */
export function dreamStatus(d: Dream): { text: string; tone: 'run' | 'wait' | 'ok' | 'quiet' | 'bad' } {
  if (d.status === 'running') return { text: 'Running', tone: 'run' };
  const count = (s: DreamProposal['state']) => d.proposals.filter((p) => p.state === s).length;
  const waiting = count('waiting');
  const planned = count('planned');
  const applied = count('applied');
  const shown = d.proposals.filter((p) => p.state !== 'withdrawn').length;
  if (planned) return { text: `Plan ready · ${planned}`, tone: 'wait' };
  if (waiting) return { text: `Waiting for you · ${waiting}`, tone: 'wait' };
  if (d.status === 'failed') return { text: `Failed: ${d.error ?? 'unknown error'}`, tone: 'bad' };
  if (!shown) return { text: d.status === 'stopped' ? 'Stopped' : 'Nothing to suggest', tone: 'quiet' };
  // Everything decided: what became of it
  const parts = ([['applied', 'Applied'], ['dismissed', 'dismissed'], ['reverted', 'reverted'], ['failed', 'failed']] as const).filter(([s]) => count(s)).map(([s, w]) => `${w} ${count(s)}`);
  const text = parts.join(' · ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1), tone: applied ? 'ok' : 'quiet' };
}

const SCOPE_WORDS = { project: 'this project', user: 'every project' };

// ---------- The card ----------

function previewOf(p: DreamProposal): HTMLElement {
  const box = h('div', { class: 'proposal-preview' });
  if (p.kind === 'skill') {
    if (p.current !== undefined) box.append(renderDiff(p.target, lineDiff(p.current, p.content), { context: 3, limit: 80 }));
    else box.append(h('pre', { class: 'proposal-text' }, p.content.trim()));
  } else if (p.kind === 'memory') {
    // The lines without their bullet: next to the diff's own + and − signs a "- " reads as a sign too
    const bare = (l: string) => l.replace(/^[-*]\s+/, '');
    const rows: DiffRow[] = [...p.remove.map((l) => ({ kind: 'del' as const, text: bare(l) })), ...p.add.map((l) => ({ kind: 'add' as const, text: bare(l) }))];
    box.append(renderDiff(p.target, rows));
  } else {
    for (const f of p.files) {
      const before = p.current?.[f.path];
      const d = h('details', { class: 'proposal-file' }, h('summary', {}, h('span', { class: 'mono' }, f.path), h('span', { class: 'proposal-file-note' }, before === undefined ? (p.current ? 'new file' : '') : before === f.content ? 'unchanged' : 'changed')));
      d.append(before !== undefined && before !== f.content ? renderDiff(f.path, lineDiff(before, f.content), { context: 3, limit: 120 }) : h('pre', { class: 'proposal-text' }, f.content));
      box.append(d);
    }
    for (const gone of Object.keys(p.current ?? {}).filter((k) => !p.files.some((f) => f.path === k))) box.append(h('div', { class: 'proposal-file gone' }, h('span', { class: 'mono' }, gone), h('span', { class: 'proposal-file-note' }, 'removed')));
  }
  return box;
}

async function act(btn: HTMLButtonElement, fn: () => Promise<unknown>): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    deps?.showError(btn, deps.cleanError(err));
  } finally {
    btn.disabled = false;
    await refreshDreaming();
  }
}

function footOf(p: DreamProposal): HTMLElement {
  const foot = h('div', { class: 'proposal-foot' });
  const state = h('span', { class: `proposal-state ${p.state}` }, STATE_WORDS[p.state]);
  if (p.error && (p.state === 'failed' || p.state === 'withdrawn')) state.append(h('span', { class: 'proposal-error' }, ` · ${p.error}`));
  foot.append(state);
  const btn = (label: string, method: 'dreaming.apply' | 'dreaming.dismiss' | 'dreaming.revert', primary = false) => {
    const b = h('button', { type: 'button', class: `btn sm${primary ? ' primary' : ''}`, 'data-action': method.split('.')[1] }, label);
    b.addEventListener('click', () => void act(b, () => rpc(method, p.id)));
    return b;
  };
  if (p.state === 'waiting' || p.state === 'planned' || p.state === 'failed') foot.append(btn('Dismiss', 'dreaming.dismiss'), btn(p.state === 'failed' ? 'Try again' : 'Apply', 'dreaming.apply', true));
  else if (p.state === 'applied') foot.append(btn('Revert', 'dreaming.revert'));
  else if (p.state === 'reverted' || p.state === 'dismissed') foot.append(btn('Apply', 'dreaming.apply'));
  return foot;
}

/** A card for one proposal; it follows the proposal's state as it changes. */
export function proposalCard(id: string, opts: { links?: boolean } = {}): HTMLElement {
  const el = h('div', { class: 'proposal-card', 'data-proposal': id });
  const render = (p: DreamProposal | undefined) => {
    el.innerHTML = '';
    if (!p) {
      el.dataset.state = 'unknown';
      el.append(h('div', { class: 'proposal-head' }, h('div', { class: 'proposal-heading' }, h('div', { class: 'proposal-kicker' }, 'Proposal'), h('div', { class: 'proposal-title' }, current ? 'This proposal is no longer kept.' : 'Loading…'))));
      return;
    }
    el.dataset.state = p.state;
    el.dataset.kind = p.kind;
    const k = KIND[p.kind];
    el.append(
      h(
        'div',
        { class: 'proposal-head' },
        h('span', { class: 'proposal-icon', html: icon(k.icon) }),
        h('div', { class: 'proposal-heading' }, h('div', { class: 'proposal-kicker' }, `${k.label} · for ${SCOPE_WORDS[p.scope]}${p.changesExisting ? ' · changes what exists' : ''}`), h('div', { class: 'proposal-title' }, p.title)),
      ),
      h('p', { class: 'proposal-why' }, p.why),
    );
    if (p.sessions.length) {
      const from = h('div', { class: 'proposal-from' }, h('span', {}, p.sessions.length === 1 ? 'From ' : 'From sessions '));
      p.sessions.forEach((sid, i) => {
        if (i) from.append(h('span', {}, ', '));
        const title = deps?.sessionTitle(sid) ?? `${sid.slice(0, 8)}…`;
        if (opts.links === false || !deps) from.append(h('span', {}, title));
        else {
          const a = h('button', { type: 'button', class: 'link-btn proposal-session', 'data-session': sid }, title);
          a.addEventListener('click', () => deps?.openSession(sid));
          from.append(a);
        }
      });
      el.append(from);
    }
    el.append(previewOf(p));
    if (p.kind === 'mod') el.append(h('p', { class: 'proposal-note' }, 'It stays off until you turn it on in Settings → Mods.'));
    el.append(h('div', { class: 'proposal-target', title: p.target }, tilde(p.target)), footOf(p));
  };
  let set = cards.get(id);
  if (!set) cards.set(id, (set = new Set()));
  const born = Date.now();
  // A card that left the page stops following (noticed on the next change; a fresh one may not be placed yet)
  const update = (p: DreamProposal | undefined) => {
    if (!el.isConnected && Date.now() - born > 2000) {
      set!.delete(update);
      return;
    }
    render(p);
  };
  set.add(update);
  render(proposalById(id));
  return el;
}

// ---------- Hookup ----------

/** The transcript item for a proposal, and the live one when a dream on screen makes a proposal. */
export function setupDreamingView(d: DreamingDeps): void {
  deps = d;
  registerTranscriptItem('proposal', (item) => (typeof item.proposalId === 'string' ? proposalCard(item.proposalId) : null));
  onPush('dreaming:changed', (s) => adoptDreaming(s));
  void refreshDreaming();
}

/** A propose_* call that ended on screen: its card joins the transcript (the main process has the proposal by now). */
export function proposalEnded(name: string, result: string, ok: boolean): boolean {
  if (!PROPOSAL_TOOLS.includes(name) || !ok) return false;
  const id = PROPOSAL_ID_RE.exec(result)?.[1];
  if (!id) return false;
  void refreshDreaming();
  return appendTranscriptItem({ role: 'proposal', proposalId: id });
}

