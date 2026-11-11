// The words of a folded run of tool calls: "Read 3 files, ran 2 commands, edited a file". One phrase per kind of
// call, in the order the kinds first appear, with counts; a kind names what the single rows say (tool-labels.ts and
// toolLabel in tools.ts) in the past tense, or in the present ("Reading 3 files, running 2 commands") for the heading
// of a live run's opened list. Pure (no DOM, no imports), so test/tool-activity.js loads it headless;
// renderer.ts puts the line together with the diff total and the failed and denied counts.

/** One call in a run, as the summary needs it */
export interface ActivityCall {
  name: string;
  /** The file a read, write or edit was about: the same file twice is one file */
  path?: string;
  /** write_file made a new file (its result says "Created …") rather than replacing one */
  created?: boolean;
  /** browser_navigate's url, which tells a page from a web search */
  url?: string;
  /** A denied call did not happen: it is left out of the words and counted on its own */
  denied?: boolean;
  /** An MCP call's real server name (mcp-labels.ts); else it is parsed from the name */
  server?: string;
}

interface Kind {
  key: string;
  one: string;
  many: (n: number) => string;
  /** Calls on the same target count once (files) */
  target?: string;
}

const files = (verb: string) => ({ one: `${verb} a file`, many: (n: number) => `${verb} ${n} files` });
const times = (phrase: string) => ({ one: phrase, many: (n: number) => `${phrase} ${n} times` });
const counted = (verb: string, a: string, noun: string, nouns = `${noun}s`) => ({ one: `${verb} ${a} ${noun}`, many: (n: number) => `${verb} ${n} ${nouns}` });

/** The kinds of the agent's own tools, by tool name */
const KINDS: Record<string, Omit<Kind, 'key' | 'target'>> = {
  read_file: files('read'),
  edit_file: files('edited'),
  list_directory: counted('listed', 'a', 'directory', 'directories'),
  glob: counted('ran', 'a', 'search', 'searches'),
  grep: counted('ran', 'a', 'search', 'searches'),
  bash: counted('ran', 'a', 'command'),
  terminal_run: counted('ran', 'a', 'command'),
  terminal_read: times('read the terminal'),
  terminal_list: times('listed the terminal tabs'),
  terminal_stop: counted('stopped', 'a', 'command'),
  skill: counted('loaded', 'a', 'skill'),
  create_artifact: counted('made', 'an', 'artifact'),
  show_image: counted('showed', 'an', 'image'),
  update_tasks: times('updated the tasks'),
  ask_user: counted('asked', 'a', 'question'),
  submit_plan: counted('wrote', 'a', 'plan'),
  session_spawn: counted('started', 'a', 'sub-session'),
  session_send: counted('sent', 'a', 'message'),
  session_list: times('listed sessions'),
  session_read: counted('read', 'a', 'session'),
  session_merge: counted('merged', 'a', 'session'),
  session_rename: times('renamed the session'),
  schedule_create: counted('created', 'a', 'schedule'),
  schedule_list: times('listed schedules'),
  schedule_update: counted('changed', 'a', 'schedule'),
  schedule_delete: counted('deleted', 'a', 'schedule'),
  mod_check: counted('checked', 'a', 'mod'),
  history_read: counted('read', 'a', 'session'),
  history_search: times('searched the sessions'),
  propose_skill: counted('proposed', 'a', 'skill'),
  propose_memory: times('proposed memory'),
  propose_mod: counted('proposed', 'a', 'mod'),
  withdraw_proposal: counted('withdrew', 'a', 'proposal'),
  browser_screenshot: counted('took', 'a', 'screenshot'),
  web_fetch: counted('fetched', 'a', 'page'),
  web_search: times('searched the web'),
};

/** What a denied call would have been, for a line of denials only: "Denied a command", "Denied 2 edits" */
const DENIED: Record<string, [string, string]> = {
  command: ['a command', 'commands'],
  edit_file: ['an edit', 'edits'],
  write: ['a file write', 'file writes'],
  create: ['a new file', 'new files'],
  session_spawn: ['a sub-session', 'sub-sessions'],
  session_send: ['a message', 'messages'],
  schedule_create: ['a schedule', 'schedules'],
  schedule_update: ['a schedule change', 'schedule changes'],
};

/** Kinds that share a phrase share a key, so "ran 2 searches" counts grep and glob together */
const SHARED: Record<string, string> = { glob: 'search', grep: 'search', bash: 'command', terminal_run: 'command', history_read: 'session_read', web_search: 'web' };

function kindOf(c: ActivityCall): Kind {
  const name = c.name;
  const server = name.startsWith('mcp__') ? c.server || /^mcp__(.+?)__(.+)$/.exec(name)?.[1] : undefined;
  if (server) return { key: `mcp:${server}`, one: `called a tool on ${server}`, many: (n) => `called ${n} tools on ${server}` };
  if (name === 'write_file') return { key: c.created ? 'create' : 'write', ...files(c.created ? 'created' : 'wrote'), target: c.path || undefined };
  if (name === 'read_file' || name === 'edit_file') return { key: name, ...KINDS[name], target: c.path || undefined };
  if (name === 'browser_navigate') {
    const url = (c.url ?? '').trim();
    if (url === 'back' || url === 'forward') return { key: 'browser', ...times('used the browser') };
    if (url && (/\s/.test(url) || !/[.:/]/.test(url))) return { key: 'web', ...times('searched the web') };
    return { key: 'page', ...counted('opened', 'a', 'page') };
  }
  if (KINDS[name]) return { key: SHARED[name] ?? name, ...KINDS[name] };
  if (name.startsWith('browser_')) return { key: 'browser', ...times('used the browser') };
  return { key: 'other', one: 'used another tool', many: (n) => `used ${n} other tools` };
}

/** More kinds than this: the first MAX_KINDS - 1 are named, then "and N more" */
export const MAX_KINDS = 4;

export interface ActivityWords {
  /** The line: "Read 3 files, ran 2 commands, edited a file" */
  text: string;
  /** Each kind's phrase, in order (all of them, also those the line leaves out) */
  phrases: string[];
  /** Calls that were denied */
  denied: number;
}

/** The present form of each phrase's leading verb: "ran a command" → "running a command" */
const PRESENT: Record<string, string> = {
  read: 'reading', edited: 'editing', listed: 'listing', ran: 'running', stopped: 'stopping', loaded: 'loading', made: 'making',
  showed: 'showing', updated: 'updating', asked: 'asking', wrote: 'writing', started: 'starting', sent: 'sending',
  merged: 'merging', renamed: 'renaming', created: 'creating', changed: 'changing', deleted: 'deleting', checked: 'checking',
  searched: 'searching', proposed: 'proposing', withdrew: 'withdrawing', took: 'taking', fetched: 'fetching', opened: 'opening',
  used: 'using', called: 'calling',
};

/** A phrase with its leading verb in the present: "read 2 files" → "reading 2 files" */
export function presentPhrase(phrase: string): string {
  const m = /^(\w+)(.*)$/.exec(phrase);
  const verb = m ? PRESENT[m[1].toLowerCase()] : undefined;
  return verb && m ? verb + m[2] : phrase;
}

export interface ActivityOptions {
  /** 'past' (default): what a run did. 'present': what a live run is doing, every call in it counted */
  tense?: 'past' | 'present';
}

/**
 * What a run of calls did, in words (or, with tense 'present', is doing). Names alone work too (each counts as one
 * call). A line of denials only stays in the past tense: nothing is happening.
 */
export function activityWords(input: (ActivityCall | string)[], opts: ActivityOptions = {}): ActivityWords {
  const present = opts.tense === 'present';
  const calls = input.map((c) => (typeof c === 'string' ? { name: c } : c));
  const kinds = new Map<string, { kind: Kind; n: number; targets: Set<string> }>();
  let denied = 0;
  /** The kinds of the denied calls, to name them when nothing else happened */
  const deniedKeys = new Set<string>();
  for (const c of calls) {
    if (c.denied) {
      denied++;
      const k = kindOf(c).key;
      deniedKeys.add(k.startsWith('mcp:') ? k : DENIED[k] ? k : 'other');
      continue;
    }
    const kind = kindOf(c);
    let k = kinds.get(kind.key);
    if (!k) kinds.set(kind.key, (k = { kind, n: 0, targets: new Set() }));
    if (kind.target) {
      if (k.targets.has(kind.target)) continue;
      k.targets.add(kind.target);
    }
    k.n++;
  }
  const phrases = [...kinds.values()].map(({ kind, n }) => (n === 1 ? kind.one : kind.many(n))).map((ph) => (present ? presentPhrase(ph) : ph));
  let text: string;
  if (!phrases.length) text = denied ? `denied ${deniedNoun(deniedKeys, denied)}` : '';
  else if (phrases.length <= MAX_KINDS) text = phrases.join(', ');
  else text = `${phrases.slice(0, MAX_KINDS - 1).join(', ')} and ${phrases.length - (MAX_KINDS - 1)} more`;
  return { text: text.charAt(0).toUpperCase() + text.slice(1), phrases, denied: phrases.length ? denied : 0 };
}

/** "a command", "2 edits", "a call to figma"; "N calls" when the denied calls were of different kinds */
function deniedNoun(keys: Set<string>, n: number): string {
  const only = keys.size === 1 ? [...keys][0] : '';
  if (only.startsWith('mcp:')) return n === 1 ? `a call to ${only.slice(4)}` : `${n} calls to ${only.slice(4)}`;
  const noun = DENIED[only];
  if (noun) return n === 1 ? noun[0] : `${n} ${noun[1]}`;
  return n === 1 ? 'a call' : `${n} calls`;
}

/** The words alone: "Read 3 files, ran 2 commands, edited a file" */
export function groupSummary(input: (ActivityCall | string)[], opts: ActivityOptions = {}): string {
  return activityWords(input, opts).text;
}
