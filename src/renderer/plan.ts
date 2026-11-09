// Plan card: a plan the model proposed in plan mode, with Build it / Build, accept edits / Keep planning. A dream's
// plan (kind 'dream') gathers its suggestions instead: Apply all / Keep planning, and approving it builds nothing.

import type { PlanInfo } from '../shared/types';
import { escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';

export type PlanDecision = 'build-ask' | 'build-acceptEdits' | 'keep';

export interface PlanCard {
  el: HTMLElement;
  plan: PlanInfo;
  /** Proposed, interactive and not decided yet */
  pending(): boolean;
  /** Applies a newer copy of the plan (session_changed, a reloaded transcript) */
  update(plan: PlanInfo): void;
  decide(decision: PlanDecision): Promise<void>;
  /** Drops the buttons of a proposed plan that a newer plan replaced */
  retire(): void;
}

export interface PlanCardOptions {
  /** Only the newest proposed plan gets buttons (and the #plan-* ids) */
  interactive: boolean;
  /** Sends the decision; resolves false when it failed (the buttons come back) */
  respond: (card: PlanCard, decision: PlanDecision, button: HTMLElement) => Promise<boolean>;
  /** Label of the permission mode a build decision switches to */
  modeLabel: (decision: Exclude<PlanDecision, 'keep'>) => string;
}

const CHIP: Record<PlanInfo['status'], string> = { proposed: 'Proposed', approved: 'Approved', rejected: 'Sent back' };

export function createPlanCard(plan: PlanInfo, opts: PlanCardOptions): PlanCard {
  const el = document.createElement('div');
  el.className = 'plan-card';
  el.dataset.planId = plan.id;
  el.innerHTML =
    `<div class="plan-head"><span class="plan-icon">${icon('clipboard')}</span>` +
    `<div class="plan-heading"><div class="plan-kicker">${plan.kind === 'dream' ? 'Dream plan' : 'Plan'}</div><div class="plan-title"></div></div>` +
    `<span class="plan-chip"></span></div>` +
    `<div class="plan-body md"></div>` +
    `<div class="plan-foot"></div>`;
  const titleEl = el.querySelector<HTMLElement>('.plan-title')!;
  const chipEl = el.querySelector<HTMLElement>('.plan-chip')!;
  const bodyEl = el.querySelector<HTMLElement>('.plan-body')!;
  const footEl = el.querySelector<HTMLElement>('.plan-foot')!;
  let interactive = opts.interactive;
  let decided: PlanDecision | null = null;
  let inFlight = false;
  let renderedMarkdown: string | null = null;

  const statusLine = (ok: boolean | null, text: string) => {
    footEl.className = 'plan-foot plan-status';
    footEl.innerHTML = `<span class="${ok === null ? 'muted' : ok ? 'ok' : 'back'}">${icon(ok === null ? 'info' : ok ? 'check' : 'undo', 14)}</span><span>${escapeHtml(text)}</span>`;
  };

  const button = (id: string, label: string, cls: string, key?: string) =>
    `<button type="button" id="${id}" class="${cls}"><span>${escapeHtml(label)}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;

  const dream = plan.kind === 'dream';
  const renderFoot = () => {
    const status = card.plan.status;
    if (decided) {
      if (decided === 'keep') statusLine(false, dream ? 'Sent back: answer below' : 'Sent back for changes');
      else statusLine(true, dream ? 'Approved · applied' : `Approved · building with ${opts.modeLabel(decided)}`);
      return;
    }
    if (status === 'approved') return statusLine(true, dream ? 'Approved · applied' : 'Approved');
    if (status === 'rejected') return statusLine(false, 'Sent back for changes');
    if (!interactive) return statusLine(null, 'Replaced by a newer plan');
    footEl.className = 'plan-foot plan-actions';
    if (dream) {
      footEl.innerHTML =
        button('plan-keep', 'Keep planning', 'btn', 'esc') +
        button('plan-build', 'Apply all', 'btn primary', '↵');
      footEl.querySelector<HTMLButtonElement>('#plan-keep')!.onclick = () => void card.decide('keep');
      footEl.querySelector<HTMLButtonElement>('#plan-build')!.onclick = () => void card.decide('build-ask');
      return;
    }
    footEl.innerHTML =
      button('plan-keep', 'Keep planning', 'btn', 'esc') +
      button('plan-build-accept', 'Build, accept edits', 'btn') +
      button('plan-build', 'Build it', 'btn primary', '↵');
    footEl.querySelector<HTMLButtonElement>('#plan-keep')!.onclick = () => void card.decide('keep');
    footEl.querySelector<HTMLButtonElement>('#plan-build-accept')!.onclick = () => void card.decide('build-acceptEdits');
    footEl.querySelector<HTMLButtonElement>('#plan-build')!.onclick = () => void card.decide('build-ask');
  };

  const render = () => {
    const p = card.plan;
    // A decision made on this card wins over a stale copy from the main process.
    const status: PlanInfo['status'] = decided ? (decided === 'keep' ? 'rejected' : 'approved') : p.status;
    el.dataset.status = status;
    titleEl.textContent = p.title?.trim() || 'Plan';
    chipEl.className = `plan-chip ${status}`;
    chipEl.textContent = CHIP[status] ?? status;
    if (renderedMarkdown !== p.markdown) {
      renderedMarkdown = p.markdown;
      bodyEl.innerHTML = renderMarkdown(p.markdown || '_The plan is empty._');
    }
    renderFoot();
  };

  const card: PlanCard = {
    el,
    plan,
    pending: () => interactive && !decided && !inFlight && card.plan.status === 'proposed',
    update(next: PlanInfo) {
      if (next.id !== card.plan.id) return;
      card.plan = { ...card.plan, ...next };
      render();
    },
    async decide(decision: PlanDecision) {
      if (!interactive || decided || inFlight || card.plan.status !== 'proposed') return;
      const id = decision === 'keep' ? 'plan-keep' : decision === 'build-ask' ? 'plan-build' : 'plan-build-accept';
      const btn = footEl.querySelector<HTMLElement>(`#${id}`) ?? footEl;
      inFlight = true;
      footEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
      const ok = await opts.respond(card, decision, btn);
      inFlight = false;
      if (!ok) {
        footEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = false));
        return;
      }
      decided = decision;
      card.plan = { ...card.plan, status: decision === 'keep' ? 'rejected' : 'approved' };
      render();
    },
    retire() {
      if (!interactive) return;
      interactive = false;
      render();
    },
  };
  render();
  return card;
}
