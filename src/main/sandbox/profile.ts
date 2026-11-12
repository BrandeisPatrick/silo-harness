// The shell sandbox's profile: from the project folder, the temp folders, the user's extra folders and the local-ports
// choice to the Seatbelt profile text and its parameters (docs/research/shell-sandbox-design.md, sections 1 and 2).
// Pure: every path comes in as an argument, already a real path (/tmp is /private/tmp).
//
// Allow by default, then deny: writes outside the project, temp and extra folders; protected names in them at any
// depth, every .git last of all; reads of secrets; the network (this Mac's own ports only when asked); other apps,
// launchd jobs, preferences, the keychain, the clipboard, notifications and signals to anything outside.

/** Inside the project and the extra folders, at any depth: what configures git, editors, CI, direnv, the app or another agent */
export const PROTECTED_NAMES = ['.silo-harness', '.open-harness', '.claude', '.vscode', '.idea', '.husky', '.github/workflows', '.mcp.json', '.envrc', '.gitmodules'];
/** …except the folders in them that hold skills, commands, agents or worktrees, no executable configuration */
export const OPEN_NAMES = ['.claude/skills', '.claude/commands', '.claude/agents', '.claude/worktrees', '.silo-harness/skills', '.open-harness/skills'];

/** Local ports a sandboxed command never reaches, even with local ports on: databases, Docker, a browser's debugger, Ollama */
export const SERVICE_PORTS = [5432, 3306, 6379, 27017, 2375, 2376, 9222, 11434];

/** The services a sandboxed command may not reach: they act outside it (open apps, write preferences, the keychain, the clipboard, notifications, background downloads) */
const DENIED_SERVICES: { name?: string; prefix?: string }[] = [
  { name: 'com.apple.coreservices.launchservicesd' },
  { prefix: 'com.apple.lsd.' },
  { name: 'com.apple.cfprefsd.daemon' },
  { name: 'com.apple.SecurityServer' },
  { prefix: 'com.apple.securityd' },
  { prefix: 'com.apple.pasteboard.' },
  // display notification (osascript) goes through usernoted: tested, "Connection to notification center invalid"
  { prefix: 'com.apple.usernoted.' },
  { prefix: 'com.apple.usernotifications.' },
  { prefix: 'com.apple.UNCUserNotification' },
  { prefix: 'com.apple.notificationcenterui.' },
  { name: 'com.apple.nsurlsessiond' },
];

/** What the profile is built from. Every path is absolute and real. */
export interface ProfileInput {
  /** The session's folder */
  project: string;
  /** The temp folders: /private/tmp and the user's own /private/var/folders/<x>/<y> (and $TMPDIR when it is elsewhere) */
  temp: string[];
  /** Folders the user listed (sandbox.allowWrite): writable, with the project's protected names and .git */
  extra: string[];
  /** Allow bind, accept and connect on this Mac's own ports (localhost), but `deniedPorts` */
  loopback: boolean;
  deniedPorts: number[];
  /** Plan mode: nothing is writable but the null device and pipes */
  readOnly: boolean;
  /** Names of secrets at any depth (.ssh, .aws, id_rsa, .config/gh …), unreadable; the .env family and key files are built in */
  secretNames: string[];
  /** Folders and files never readable: the app's data, browser profiles, the keychains, the settings files */
  secretPaths: string[];
  /** Folders and files never writable wherever they are: shell start-up files, launch agents, the app's data, the rule files */
  protectedPaths: string[];
  /** Folders that cannot be moved or removed themselves (the ones that hold a rule file); what is in them is decided by the rest */
  protectedFolders: string[];
}

export interface Profile {
  text: string;
  /** -D parameters: NAME → path */
  params: Record<string, string>;
}

/** Characters a Seatbelt regex treats as more than themselves */
export function escapeRegex(s: string): string {
  return s.replace(/[\\.^$*+?()[\]{}|]/g, (c) => `\\${c}`);
}


// Seatbelt's regexes ignore case (tested: a deny of /ABC$ refuses abc too), as APFS does by default: .GIT is .git.
// Inside […] a - goes first: a trailing one is refused ("unterminated bracket expression").

/**
 * True when a path can go into the profile: absolute, and with no quote, backslash or control character (a regex
 * literal #"…" cannot hold them safely). A folder that cannot is not sandboxed: its commands go to the check.
 */
export function embeddable(p: string): boolean {
  return p.startsWith('/') && !/["\\\x00-\x1f\x7f]/.test(p);
}

const alternation = (names: string[]): string => names.map(escapeRegex).join('|');

/** a is b or a folder that holds b */
function holds(a: string, b: string): boolean {
  return a === b || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

/**
 * The profile text and its parameters, or null when a folder cannot be embedded. Order matters: the last rule that
 * matches wins, so every .git is denied after the open folders are allowed, and the protected paths after the writable
 * folders.
 */
export function buildProfile(input: ProfileInput): Profile | null {
  const project = input.project.replace(/\/+$/, '') || '/';
  if (!embeddable(project) || project === '/') return null;
  const params: Record<string, string> = { PROJECT: project };
  const param = (prefix: string, value: string): string => {
    let i = 0;
    while (`${prefix}${i}` in params) i++;
    params[`${prefix}${i}`] = value;
    return `(param "${prefix}${i}")`;
  };
  // The folders a command may write besides the project (none in Plan mode): the root, a folder inside the project
  // and a folder that cannot be embedded are left out
  const roots = (list: string[]) => [...new Set(list.map((p) => p.replace(/\/+$/, '') || '/'))].filter((p) => embeddable(p) && p !== '/' && !(holds(project, p) && p !== project));
  const extra = input.readOnly ? [] : roots(input.extra).filter((p) => p !== project);
  const temp = input.readOnly ? [] : roots(input.temp);
  const extraRefs = extra.map((e) => ({ path: e, ref: param('EXTRA', e) }));
  const workspaces = [{ path: project, ref: '(param "PROJECT")' }, ...extraRefs];
  const out: string[] = ['(version 1)', '(allow default)', ''];

  // ---------- Writes ----------
  out.push(';; Writes: only the project, the temp folders and the folders the user listed; the null device and pipes');
  out.push('(deny file-write*)');
  const devices = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/tty")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/fd/[0-9]+$")'];
  if (input.readOnly) out.push(`(allow file-write* ${devices.join(' ')})`);
  else {
    const writable = [...workspaces.map((w) => `(subpath ${w.ref})`), ...temp.map((t) => `(subpath ${param('TEMP', t)})`)];
    out.push(`(allow file-write*\n  ${[...writable, ...devices].join('\n  ')})`);
    out.push(';; The project folder and each listed folder itself cannot be moved, removed or replaced');
    out.push(`(deny file-write* ${workspaces.map((w) => `(literal ${w.ref})`).join(' ')})`);
    const names = alternation(PROTECTED_NAMES);
    const open = alternation(OPEN_NAMES);
    out.push(';; In them, at any depth: what configures editors, CI, direnv, the app or another agent; their skills, commands, agents and worktrees stay open');
    out.push(`(deny file-write*\n  ${workspaces.map((w) => `(regex #"^${escapeRegex(w.path)}/(.*/)?(${names})(/|$)")`).join('\n  ')})`);
    out.push(`(allow file-write*\n  ${workspaces.map((w) => `(regex #"^${escapeRegex(w.path)}/(.*/)?(${open})(/|$)")`).join('\n  ')})`);
    const keep = [...input.protectedPaths.filter(embeddable).map((p) => `(subpath ${param('KEEP', p)})`), ...input.protectedFolders.filter(embeddable).map((p) => `(literal ${param('KEEP', p)})`)];
    if (keep.length) {
      out.push(";; Wherever they are: shell start-up files, launch agents, keys, the app's data, the files that hold permission rules and their folders");
      out.push(`(deny file-write*\n  ${keep.join('\n  ')})`);
    }
    out.push(';; Every .git, at any depth: read-only, and it cannot be made, moved or replaced');
    out.push(`(deny file-write*\n  ${workspaces.map((w) => `(regex #"^${escapeRegex(w.path)}/(.*/)?\\.git(/|$)")`).join('\n  ')})`);
  }
  out.push('');

  // ---------- Reads ----------
  // file-read-data only: a secret's name and size stay visible (ls -la in a folder with a .env works), its content does not
  out.push(';; Reads: everything but secrets (their content; ls still lists them)');
  out.push('(deny file-read-data (regex #"/\\.env(\\.[-a-z0-9_]+)?(/|$)"))');
  out.push('(allow file-read-data (regex #"/\\.env\\.(example|sample|template|dist)(/|$)"))');
  const secretRules = [
    `(regex #"/(${input.secretNames.map(escapeRegex).join('|')})(/|$)")`,
    '(regex #"/[^/]*\\.(pem|p12|key)(/|$)")',
    ...input.secretPaths.filter(embeddable).map((p) => `(subpath ${param('SECRET', p)})`),
  ];
  out.push(`(deny file-read-data\n  ${secretRules.join('\n  ')})`);
  out.push('');

  // ---------- Network ----------
  out.push(input.loopback ? ';; Network: this Mac\'s own ports only (not the well-known services or Silo\'s own), Unix sockets in the project; no name lookups' : ';; Network: none, but Unix sockets in the project; no name lookups');
  out.push('(deny network*)');
  if (input.loopback) {
    // Allow and deny in the same kind of filter (ip4, ip6): a port deny written as tcp, tcp4 or ip after an allow
    // written as ip held for some port numbers and not others, and require-not never; this form held for every
    // port tried (280 of 280, 127.0.0.1 and ::1)
    out.push('(allow network-bind network-inbound (local ip4 "localhost:*") (local ip6 "localhost:*"))');
    out.push('(allow network-outbound (remote ip4 "localhost:*") (remote ip6 "localhost:*"))');
    const ports = [...new Set(input.deniedPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
    if (ports.length) out.push(`(deny network-outbound\n  ${ports.map((p) => `(remote ip4 "localhost:${p}") (remote ip6 "localhost:${p}")`).join('\n  ')})`);
  }
  out.push('(allow network-bind network-inbound network-outbound (local unix-socket (subpath (param "PROJECT"))) (remote unix-socket (subpath (param "PROJECT"))))');
  out.push('');

  // ---------- Other processes ----------
  out.push(';; Other apps and processes: no Apple Events, no opening apps or files, no launchd jobs, no preferences, no task ports or signals outside');
  out.push('(deny appleevent-send)');
  out.push('(deny lsopen)');
  out.push('(deny job-creation)');
  out.push('(deny user-preference-write)');
  out.push(`(deny mach-lookup\n  ${DENIED_SERVICES.map((s) => (s.name ? `(global-name "${s.name}")` : `(global-name-prefix "${s.prefix}")`)).join('\n  ')})`);
  out.push('(deny signal)');
  out.push('(allow signal (target same-sandbox))');
  out.push('(deny mach-priv-task-port)');
  out.push('(allow mach-priv-task-port (target same-sandbox))');
  return { text: out.join('\n') + '\n', params };
}

/** The arguments for /usr/bin/sandbox-exec: the profile, its parameters, then the command. */
export function sandboxArgs(profile: Profile, argv: string[]): string[] {
  const out = ['-p', profile.text];
  for (const [k, v] of Object.entries(profile.params)) out.push('-D', `${k}=${v}`);
  return [...out, '--', ...argv];
}
