// Find in page: the bar under the URL bar searches the active tab with Chromium's own findInPage, and the matches it
// reports (found-in-page) go back to the window as "3 of 12". A new text starts a new search, the same text again
// moves to the next or previous match, and an empty text (or closing the bar, a tab switch, a navigation) stops the
// search and clears its highlight. The step rule and the result's cleaning are pure: test/browser-polish.js.

import type { WebContents } from 'electron';
import type { FindResultState } from '../../shared/browser';

/** What one keystroke or Enter in the bar asks of the page. */
export type FindStep = { kind: 'stop' } | { kind: 'find'; text: string; options: { forward: boolean; findNext: boolean; matchCase: boolean } };

/**
 * The step for `text` after the search for `previous` ('' when none runs): nothing to find stops the search; a text
 * that differs starts a new search (Electron's findNext: true) from the top, forwards; the same text again moves to
 * the next match, or the one before with `forward` false. Case is ignored, as in Chrome.
 */
export function findStep(previous: string, text: string, forward = true): FindStep {
  const t = String(text ?? '');
  if (!t) return { kind: 'stop' };
  const fresh = t !== previous;
  return { kind: 'find', text: t, options: { forward: fresh ? true : forward, findNext: fresh, matchCase: false } };
}

/** Chromium's found-in-page result as Electron gives it (the fields this file reads). */
export interface FoundInPage {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/**
 * What the bar shows after a result of the request it waits for, starting from what it showed: Chromium reports a
 * search in several updates, an early one may carry the active match before the count, so a missing (zero) field
 * keeps the value before; the last update is final. A result of an older request is ignored (null).
 */
export function foldFound(shown: Pick<FindResultState, 'matches' | 'active'>, result: FoundInPage, latestRequest: number): Pick<FindResultState, 'matches' | 'active' | 'final'> | null {
  if (!result || result.requestId !== latestRequest) return null;
  const matches = Number(result.matches) || 0;
  const active = Number(result.activeMatchOrdinal) || 0;
  if (result.finalUpdate) return { matches, active: matches ? Math.min(Math.max(active, 1), matches) : 0, final: true };
  return { matches: matches || shown.matches, active: active || shown.active, final: false };
}

/** "3 of 12", or "No results" once a search is over with none; '' while nothing is known. The window has its own copy. */
export function findLabel(r: Pick<FindResultState, 'matches' | 'active' | 'final'>): string {
  if (r.matches > 0) return `${Math.max(1, r.active)} of ${r.matches}`;
  return r.final ? 'No results' : '';
}

/** One tab's search: the text it runs for, the request whose results count, what was last reported. */
export class PageFinder {
  private text = '';
  private request = 0;
  private shown = { matches: 0, active: 0 };

  constructor(
    private readonly wc: WebContents,
    private readonly onResult: (r: Omit<FindResultState, 'tabId'>) => void,
  ) {
    wc.on('found-in-page', (_e, result) => {
      const next = foldFound(this.shown, result as FoundInPage, this.request);
      if (!next || !this.text) return;
      this.shown = { matches: next.matches, active: next.active };
      this.onResult({ text: this.text, ...next });
    });
  }

  /** The bar's text changed (a new search) or Enter / ⇧Enter (the next or previous match). */
  find(text: string, forward = true): void {
    if (this.wc.isDestroyed()) return;
    const step = findStep(this.text, text, forward);
    if (step.kind === 'stop') {
      this.stop();
      this.onResult({ text: '', matches: 0, active: 0, final: true });
      return;
    }
    if (step.options.findNext) this.shown = { matches: 0, active: 0 };
    this.text = step.text;
    this.request = this.wc.findInPage(step.text, step.options);
  }

  /** Ends the search and clears its highlight (the bar closed, the tab went to the background, a new page came). True when one ran. */
  stop(): boolean {
    const was = Boolean(this.text);
    this.text = '';
    this.request = 0;
    this.shown = { matches: 0, active: 0 };
    if (was && !this.wc.isDestroyed()) this.wc.stopFindInPage('clearSelection');
    return was;
  }
}
