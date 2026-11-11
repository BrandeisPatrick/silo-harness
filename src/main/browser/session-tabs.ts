// The Browser pane per session: each session has its own set of tabs (a BrowserController), so a new session, a
// sub-session and a fork start with none of another's. A set starts as one blank tab (the New tab page), made when
// its session comes on screen or its agent first uses the browser. The window's pane shows the set of the session in
// front and swaps when another session comes forward; the other sets stay parked, and their agents keep working on
// their own tabs. A set left with only its untouched blank tab is dropped when its session leaves the screen. Pane
// bounds and visibility are the window's and reach every set. Deleting a session closes its set. No Electron here
// (the unit tests drive it with plain objects).

import type { Bounds, BrowserState } from '../../shared/browser';

/** What the window shows for a session with no tabs: the New tab page. */
export const NO_TABS: BrowserState = { tabs: [], activeId: '', url: '', title: '', canGoBack: false, canGoForward: false, loading: false };

/** The part of a session's set (a BrowserController) this file needs. */
export interface SessionTabSet {
  /** Its session came on screen (it then pushes its state and popups) or left it */
  setInFront(front: boolean): void;
  setBounds(b: Bounds): void;
  setVisible(v: boolean): void;
  hasTab(id: string): boolean;
  /** It holds only the blank tab it started with, never used */
  isPristine(): boolean;
  /** Its tabs close; it is not used again */
  dispose(): void;
}

export interface SessionTabsOptions<C extends SessionTabSet> {
  /** A new set for `sessionId` (one blank tab), on screen or not */
  make(sessionId: string, inFront: boolean): C;
}

export class SessionTabs<C extends SessionTabSet> {
  private readonly sets = new Map<string, C>();
  private bounds: Bounds | null = null;
  private visible: boolean | null = null;

  constructor(
    private front: string,
    private readonly o: SessionTabsOptions<C>,
  ) {}

  /** The session whose tabs the pane shows. */
  frontId(): string {
    return this.front;
  }

  /** A session's set; with `create`, made when it has none yet. */
  of(sessionId: string, create = true): C | null {
    let set = this.sets.get(sessionId);
    if (!set && create && sessionId) {
      set = this.o.make(sessionId, sessionId === this.front);
      if (this.bounds) set.setBounds(this.bounds);
      if (this.visible !== null) set.setVisible(this.visible);
      this.sets.set(sessionId, set);
    }
    return set ?? null;
  }

  /** The set of the session in front. */
  current(create = false): C | null {
    return this.of(this.front, create);
  }

  /**
   * Another session came on screen: its set shows (a new one when it has none), the one before is parked, or dropped
   * when it holds only its untouched blank tab.
   */
  setFront(sessionId: string): void {
    if (sessionId === this.front) return;
    const beforeId = this.front;
    const before = this.sets.get(beforeId);
    this.front = sessionId;
    if (before?.isPristine()) this.drop(beforeId);
    else before?.setInFront(false);
    const next = this.sets.get(sessionId);
    if (next) next.setInFront(true);
    else this.of(sessionId);
  }

  /** The pane's slot in the window, for every set (a parked one keeps the size). */
  setBounds(b: Bounds): void {
    this.bounds = { ...b };
    for (const set of this.sets.values()) set.setBounds(b);
  }

  /** The pane shown or hidden: the window's, for every set. */
  setVisible(v: boolean): void {
    this.visible = v;
    for (const set of this.sets.values()) set.setVisible(v);
  }

  /** A session was deleted: its tabs close (the session in front starts again with a blank tab). */
  close(sessionId: string): void {
    if (!this.drop(sessionId)) return;
    if (sessionId === this.front) this.of(sessionId);
  }

  private drop(sessionId: string): boolean {
    const set = this.sets.get(sessionId);
    if (!set) return false;
    this.sets.delete(sessionId);
    set.dispose();
    return true;
  }

  /** Every set closes (the window went); none is made again. */
  closeAll(): void {
    for (const id of [...this.sets.keys()]) this.drop(id);
  }

  /** Every set, the one in front first. */
  all(): C[] {
    const front = this.sets.get(this.front);
    return front ? [front, ...[...this.sets.values()].filter((s) => s !== front)] : [...this.sets.values()];
  }

  /** The set a tab belongs to, and its session. */
  owner(tabId: string): { sessionId: string; set: C } | null {
    for (const [sessionId, set] of this.sets) if (set.hasTab(tabId)) return { sessionId, set };
    return null;
  }

  /** The sessions that have a set now. */
  sessions(): string[] {
    return [...this.sets.keys()];
  }
}
