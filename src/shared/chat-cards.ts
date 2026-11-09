// Chat cards: the pull requests, artifacts and documents a reply or a tool result names, drawn in the transcript as
// cards (src/renderer/chat-cards.ts). What the window asks the main process for them (src/main/chat-cards.ts). Types only.

/** A GitHub pull request as its URL names it. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** The canonical URL: https://github.com/<owner>/<repo>/pull/<number> */
  url: string;
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** The checks on the pull request's head commit, summed up. */
export interface PullRequestChecks {
  state: 'passing' | 'failing' | 'pending';
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/**
 * What a card shows of a pull request. `found` is false when `gh` is missing, not signed in, or the call failed: the
 * card then shows what the URL alone gives (the repository, the number and the link) and `error` says why.
 */
export interface PullRequestInfo {
  ref: PullRequestRef;
  found: boolean;
  title?: string;
  state?: PullRequestState;
  /** The author's login */
  author?: string;
  /** When it was opened, merged or closed (per state), ms since the epoch */
  at?: number;
  files?: number;
  additions?: number;
  deletions?: number;
  checks?: PullRequestChecks | null;
  /** 'approved', 'changes' (changes requested) or 'required' (review required), when GitHub says */
  review?: 'approved' | 'changes' | 'required' | null;
  /** The branch cannot merge as it is */
  conflicts?: boolean;
  /** Why the card has only what the URL gives ("gh is not installed", "gh is not signed in", …) */
  error?: string;
  /** When the main process last asked gh, ms since the epoch */
  fetchedAt: number;
}

/** Where a document went when it was opened. */
export type DocumentOpened = 'pane' | 'external';

export interface ChatCardsRpc {
  /**
   * A pull request's card data, from `gh pr view <url> --json …`. The window asks each time a card is shown; an
   * answer less than a minute old is given again, so gh runs at most once a minute per pull request. Rejects only
   * for a URL that is not a GitHub pull request.
   */
  'cards.pullRequest': (url: string) => PullRequestInfo;
  /**
   * Opens a document file the agent wrote: Markdown, plain text and HTML in the Browser pane's viewer (unless
   * `external`), anything else (a PDF) with the Mac's default app. Rejects when the file is gone.
   */
  'cards.openDocument': (path: string, opts?: { external?: boolean }) => DocumentOpened;
  /** Shows the document in Finder. */
  'cards.revealDocument': (path: string) => void;
}
