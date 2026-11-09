// The chat cards' pure pieces (no DOM, checked headless by test/chat-cards.js): which GitHub pull requests a reply
// or a tool result names, which files the agent wrote are documents, and the words and numbers the cards show.
// The phone page (remote/app.js) keeps a small copy of the detection.

import type { PullRequestInfo, PullRequestRef, PullRequestState } from '../shared/chat-cards';

const PR_IN_TEXT = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?!\d)/gi;

/** A reply that names more pull requests than this is a list of them, and gets no cards */
export const MAX_PR_CARDS = 3;

/** Every pull request a text names (URLs, Markdown links), once each, in order. */
export function findPullRequests(text: string): PullRequestRef[] {
  const out: PullRequestRef[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? '').matchAll(PR_IN_TEXT)) {
    const [, owner, repo] = m;
    const number = Number(m[3]);
    if (repo === '.' || repo === '..' || /\.git$/i.test(repo) || !(number >= 1)) continue;
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo, number, url });
  }
  return out;
}

/** The pull requests a reply's cards are for: none when it names more than MAX_PR_CARDS (a list, not "the PR"). */
export function replyPullRequests(text: string): PullRequestRef[] {
  const all = findPullRequests(text);
  return all.length > MAX_PR_CARDS ? [] : all;
}

/** Shell calls whose output names the pull request they made or read (gh by name or by its path) */
const GH_PR_COMMAND = /(?:^|[\s;&|(])(?:[\w./~-]*\/)?gh\s+pr\s+(?:create|view|new|ready|merge|reopen|edit|status)\b/;

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** A shell call's result that ends in a failing exit code ("[exit code: 1]", as bash and terminal_run end theirs). */
function failedShell(result: string): boolean {
  const m = /(?:^|\n)\[exit code: ([^\]\n]+)\]\s*$/.exec(result);
  return Boolean(m && m[1].trim() !== '0' && /^-?\d+$/.test(m[1].trim()));
}

/**
 * The pull requests a finished tool call names: a `gh pr create` / `gh pr view` (…) run through bash or the terminal,
 * or a GitHub tool from an MCP server that makes or reads one. A failed call names none.
 */
export function toolPullRequests(name: string, rawArgs: unknown, result: string, ok: boolean): PullRequestRef[] {
  if (!ok) return [];
  const text = String(result ?? '');
  if (name === 'bash' || name === 'terminal_run') {
    const command = String(argsOf(rawArgs).command ?? '');
    if (!GH_PR_COMMAND.test(command) || failedShell(text)) return [];
    // `gh pr view <url>` names it in the command; create and view print it
    const found = findPullRequests(`${command}\n${text}`);
    return found.length > MAX_PR_CARDS ? [] : found;
  }
  if (/pull.?request/i.test(name) && !/^\s*Error\b/.test(text)) {
    const found = findPullRequests(text);
    return found.length ? [found[0]] : [];
  }
  return [];
}

/** A document the agent wrote, as its card shows it. */
export interface DocumentRef {
  /** Absolute path */
  path: string;
  title: string;
  /** "MD", "HTML", "PDF", "TXT" */
  label: string;
}

const DOC_LABELS: Record<string, string> = { md: 'MD', markdown: 'MD', mdx: 'MD', html: 'HTML', htm: 'HTML', pdf: 'PDF', txt: 'TXT', text: 'TXT' };
/** Text files that are a tool's input, not something written to be read */
const NOT_DOCUMENTS = /^(requirements[\w.-]*|constraints|robots|cmakelists|llms)\.txt$/i;
/**
 * A project's own files, which the agent keeps up to date as part of the work (README.md, CHANGELOG.md, CLAUDE.md, …):
 * no card, however they are spelled (README.ja.md, CLAUDE.local.md). A card is for a document written to be read.
 */
const PROJECT_FILES = new Set(['readme', 'changelog', 'changes', 'history', 'news', 'contributing', 'license', 'licence', 'notice', 'copying', 'authors', 'contributors', 'code_of_conduct', 'security', 'support', 'third_party_notices', 'claude', 'agents', 'gemini', 'copilot-instructions', 'pull_request_template']);

/** The extension's label ("MD") when the file is a document, else null. */
export function documentLabel(file: string): string | null {
  const name = baseName(file);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const label = DOC_LABELS[name.slice(dot + 1).toLowerCase()];
  if (!label || NOT_DOCUMENTS.test(name) || PROJECT_FILES.has(name.slice(0, name.indexOf('.')).toLowerCase())) return null;
  return label;
}

function baseName(p: string): string {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

/** A path made absolute against the working directory (and "~" against home), "." and ".." resolved. */
export function absoluteFrom(p: string, cwd: string, home = ''): string {
  let s = String(p ?? '').trim();
  if (s === '~' || s.startsWith('~/')) s = home + s.slice(1);
  else if (!s.startsWith('/')) s = `${String(cwd ?? '').replace(/\/+$/, '')}/${s}`;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** "trend-log.md" → "Trend log"; a name with capitals or spaces keeps them ("README", "Q3 Plan"). */
export function documentTitle(file: string): string {
  const name = baseName(file);
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  if (!stem) return name;
  if (stem !== stem.toLowerCase()) return stem;
  const words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The document a finished tool call wrote: write_file to a Markdown, HTML, PDF or plain-text file (not a project file
 * like README.md, nor one inside a dependency or dot folder). Edits to a file leave no card.
 */
export function toolDocument(name: string, rawArgs: unknown, result: string, ok: boolean, cwd: string, home = ''): DocumentRef | null {
  if (name !== 'write_file' || !ok || /^\s*Error\b/.test(String(result ?? ''))) return null;
  const raw = String(argsOf(rawArgs).path ?? '').trim();
  if (!raw) return null;
  const label = documentLabel(raw);
  if (!label) return null;
  const path = absoluteFrom(raw, cwd, home);
  if (/\/(node_modules|\.git|\.[^/]+)\//.test(path.slice(0, path.length - baseName(path).length))) return null;
  return { path, title: documentTitle(path), label };
}

// ---------- The pull request card's words ----------

export const PR_STATE_LABEL: Record<PullRequestState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** "just now", "20m ago", "3h ago", "5d ago", then "Mar 3" (this year) or "Mar 3, 2025". */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const date = new Date(at);
  const month = date.toLocaleString('en-US', { month: 'short' });
  return date.getFullYear() === new Date(now).getFullYear() ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/** "owner/repo #3 · author · 20m ago" (what is known of it). */
export function prMetaLine(info: Pick<PullRequestInfo, 'ref' | 'author' | 'at'>, now: number): string {
  const parts = [`${info.ref.owner}/${info.ref.repo} #${info.ref.number}`];
  if (info.author) parts.push(info.author);
  if (typeof info.at === 'number' && info.at > 0) parts.push(relativeTime(info.at, now));
  return parts.join(' · ');
}

const grouped = (n: number) => Math.max(0, Math.floor(n)).toLocaleString('en-US');

/** "198 files", "1 file" */
export function filesLabel(n: number): string {
  return `${grouped(n)} ${n === 1 ? 'file' : 'files'}`;
}

/** ["+12,349", "−8,032"] (a real minus sign) */
export function diffLabels(additions: number, deletions: number): [string, string] {
  return [`+${grouped(additions)}`, `−${grouped(deletions)}`];
}

export type FooterTone = 'ok' | 'bad' | 'wait' | 'info';

/**
 * The line under the hairline, when there is something to say: the checks, a review that asks for changes or
 * approved it, merge conflicts; or why the card shows only the link. Merged and closed pull requests have none.
 */
export function prFooter(info: PullRequestInfo): { text: string; tone: FooterTone } | null {
  if (!info.found) return { text: `Status unavailable · ${info.error || 'gh gave no answer'}`, tone: 'info' };
  if (info.state === 'merged' || info.state === 'closed') return null;
  const parts: string[] = [];
  let tone: FooterTone | null = null;
  const worse = (t: FooterTone) => {
    const rank: Record<FooterTone, number> = { info: 0, ok: 1, wait: 2, bad: 3 };
    if (!tone || rank[t] > rank[tone]) tone = t;
  };
  if (info.conflicts) {
    parts.push('Merge conflicts');
    worse('bad');
  }
  const c = info.checks;
  if (c && c.total > 0) {
    if (c.state === 'failing') {
      parts.push(`${c.failed} of ${c.total} ${c.total === 1 ? 'check' : 'checks'} failed`);
      worse('bad');
    } else if (c.state === 'pending') {
      parts.push(`Checks running · ${c.passed + c.failed} of ${c.total} done`);
      worse('wait');
    } else {
      parts.push(c.total === 1 ? 'The check passed' : `All ${c.total} checks passed`);
      worse('ok');
    }
  }
  if (info.review === 'changes') {
    parts.push('Changes requested');
    worse('bad');
  } else if (info.review === 'approved') {
    parts.push('Approved');
    worse('ok');
  } else if (info.review === 'required') {
    parts.push('Review required');
    worse('info');
  }
  return parts.length && tone ? { text: parts.join(' · '), tone } : null;
}
