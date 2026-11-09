// What "~" stands for in a path the window shows: the user's home folder, as the app reports it (preload: oc.homeDir).
// Where that is not known (a module loaded on its own in a test), any /Users/<name> counts, and /home/<name> when a
// path is being resolved rather than shown.
let home = clean((globalThis as { oc?: { homeDir?: unknown } }).oc?.homeDir);

function clean(dir: unknown): string {
  const s = typeof dir === 'string' ? dir.replace(/\/+$/, '') : '';
  return s.startsWith('/') ? s : '';
}

/** For tests, and for a home folder learned later */
export function setHomeDir(dir: string | undefined): void {
  home = clean(dir);
}

/** The home folder. When it is not known: the one a path inside it (`hint`, the working directory) points at, or ''. */
export function homeDir(hint = ''): string {
  return home || (/^\/(?:Users|home)\/[^/]+/.exec(hint)?.[0] ?? '');
}

/** "/Users/me/src/app" → "~/src/app"; a path outside the home folder is returned as it is */
export function tilde(p: string): string {
  const s = String(p ?? '');
  if (!home) return s.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
  if (s === home) return '~';
  return s.startsWith(home + '/') ? '~' + s.slice(home.length) : s;
}

/** "~/Documents/silo-harness"; long paths keep the root and the last two folders: "~/…/audit/playground". */
export function shortPath(p: string): string {
  const short = tilde(p);
  if (short.length <= 40) return short;
  const parts = short.split('/');
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : short;
}
