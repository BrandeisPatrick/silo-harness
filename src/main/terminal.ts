// Terminal pane backend: shell tabs on pseudo-terminals (node-pty), a headless xterm per tab that keeps the
// screen so the agent can read it, and zsh shell integration (OSC 133 prompt/command markers) so a run knows
// when its command finished and with which exit code. Tabs are app-wide and outlive renderer reloads.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Terminal as HeadlessTerminal, type IMarker } from '@xterm/headless';
import type { TerminalTabInfo } from '../shared/types';
import { programsOf } from './guard';

type IPty = import('node-pty').IPty;

export interface TerminalManagerOptions {
  /** Where the zsh startup shim lives (userData/zsh); created on first use */
  dataDir: string;
  /** Working directory for new tabs */
  cwd: () => string;
  /** Shell to run; defaults to $SHELL or /bin/zsh */
  shell?: string;
}

export interface RunResult {
  /** What the command printed (screen lines), without the echoed command line */
  output: string;
  /** True when shell integration reported the command finished (or the shell exited) */
  finished: boolean;
  exitCode?: number;
  elapsedMs: number;
  /** False for shells without integration: output was captured once it went quiet */
  integration: boolean;
}

/** Raw bytes kept per tab so a fresh xterm (after a reload) can replay what the tab showed. */
const HISTORY_LIMIT = 256 * 1024;
const SCROLLBACK = 5000;
/** Without shell integration a command counts as done once output stops for this long. */
const QUIET_MS = 600;
const DEFAULT_TIMEOUT = 15_000;

interface Pending {
  command: string;
  startedAt: number;
  /** Row of the prompt line the command was typed on (fallback start when no OSC 133;C arrives) */
  promptRow: IMarker | undefined;
  resolve: (r: RunResult) => void;
  timer: NodeJS.Timeout;
  quietTimer?: NodeJS.Timeout;
}

interface Tab {
  info: TerminalTabInfo;
  pty: IPty;
  screen: HeadlessTerminal;
  history: string[];
  historyBytes: number;
  /** Seen an OSC 133 marker from this shell */
  integration: boolean;
  /** Row where the running command's output starts (OSC 133;C) */
  outputStart: IMarker | undefined;
  /** A title the running program set (OSC 0/2) */
  osTitle: string;
  lastOutputAt: number;
  waiters: Set<() => void>;
  pending: Pending | null;
  /** Resolves at the shell's first prompt (zsh marker), or shortly after its first output for other shells */
  ready: Promise<void>;
  markReady: () => void;
  seenOutput: boolean;
}

let ptyModule: typeof import('node-pty') | null = null;

/** Loads node-pty on first use, making sure its spawn helper is executable (npm can drop the bit). */
function loadPty(): typeof import('node-pty') {
  if (ptyModule) return ptyModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyModule = require('node-pty') as typeof import('node-pty');
  try {
    const entry = require.resolve('node-pty').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const helper = path.join(path.dirname(entry), '..', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
  } catch (err) {
    console.warn('[terminal] could not check node-pty spawn-helper:', err);
  }
  return ptyModule;
}

function programName(command: string): string {
  const p = programsOf(command)[0] ?? command.trim().split(/\s+/)[0] ?? '';
  return path.basename(p);
}

/** The zsh startup shim: runs the user's own startup files, then adds the prompt/command hooks. */
// The variables carry the new names (SILO_HARNESS_…); the old ones (OPEN_HARNESS_…) are set alongside for one release,
// for a user's startup file that reads them.
const ZSHENV = `# Silo Harness terminal: zsh startup shim. It loads your own startup files and adds shell integration
# (prompt and command markers) so the app can tell when a command finished. Nothing is stored here.
SILO_HARNESS_ZDOTDIR="\${ZDOTDIR}"
OPEN_HARNESS_ZDOTDIR="\${ZDOTDIR}"
if [[ -f "\${SILO_HARNESS_USER_ZDOTDIR}/.zshenv" ]]; then
  ZDOTDIR="\${SILO_HARNESS_USER_ZDOTDIR}"
  . "\${SILO_HARNESS_USER_ZDOTDIR}/.zshenv"
  SILO_HARNESS_USER_ZDOTDIR="\${ZDOTDIR}"
  OPEN_HARNESS_USER_ZDOTDIR="\${ZDOTDIR}"
  ZDOTDIR="\${SILO_HARNESS_ZDOTDIR}"
fi
`;
const ZPROFILE = `if [[ -f "\${SILO_HARNESS_USER_ZDOTDIR}/.zprofile" ]]; then
  ZDOTDIR="\${SILO_HARNESS_USER_ZDOTDIR}"
  . "\${SILO_HARNESS_USER_ZDOTDIR}/.zprofile"
  ZDOTDIR="\${SILO_HARNESS_ZDOTDIR}"
fi
`;
const ZSHRC = `if [[ -f "\${SILO_HARNESS_USER_ZDOTDIR}/.zshrc" ]]; then
  ZDOTDIR="\${SILO_HARNESS_USER_ZDOTDIR}"
  . "\${SILO_HARNESS_USER_ZDOTDIR}/.zshrc"
  ZDOTDIR="\${SILO_HARNESS_ZDOTDIR}"
fi
if [[ -o interactive && "\${SILO_HARNESS_TERMINAL:-\${OPEN_HARNESS_TERMINAL}}" == "1" ]]; then
  typeset -g __oc_ran=0
  __oc_preexec() {
    __oc_ran=1
    printf '\\e]633;E;%s\\a\\e]133;C\\a' "$(print -rn -- "$1" | base64 | tr -d '\\n')"
  }
  __oc_precmd() {
    local __oc_status=$?
    if (( __oc_ran )); then
      printf '\\e]133;D;%s\\a' "$__oc_status"
      __oc_ran=0
    fi
    printf '\\e]7;file://%s%s\\a' "\${HOST}" "\${PWD}"
    printf '\\e]133;A\\a'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec __oc_preexec
  add-zsh-hook precmd __oc_precmd
fi
# Hand ZDOTDIR back so .zlogin and nested shells use your own files.
ZDOTDIR="\${SILO_HARNESS_USER_ZDOTDIR}"
`;

export class TerminalManager extends EventEmitter {
  private readonly tabs = new Map<string, Tab>();
  private seq = 0;
  private shimDir: string | null = null;
  /** The size the renderer last reported; tabs the agent opens start at this size so nothing re-wraps when the pane fits them */
  private lastSize: { cols: number; rows: number } | null = null;

  constructor(private readonly opts: TerminalManagerOptions) {
    super();
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => ({ ...t.info }));
  }

  get(id: string): TerminalTabInfo | undefined {
    const t = this.tabs.get(id);
    return t ? { ...t.info } : undefined;
  }

  /** The tab the agent's tools use when none is named: the newest one that is still alive. */
  defaultTab(): TerminalTabInfo | undefined {
    const alive = [...this.tabs.values()].filter((t) => t.info.exitCode === undefined);
    const t = alive[alive.length - 1];
    return t ? { ...t.info } : undefined;
  }

  /**
   * Opens a shell tab. Without a size, the last size the renderer reported is used (or 120×30). `cwd` overrides the
   * app's folder: the agent opens its tabs in its own session's folder, which may not be the one on screen.
   */
  create(cols?: number, rows?: number, agent = false, cwd = this.opts.cwd()): TerminalTabInfo {
    const shellPath = this.opts.shell ?? process.env.SHELL ?? '/bin/zsh';
    const shell = path.basename(shellPath);
    const env = this.environment(shell);
    const id = `tab-${++this.seq}`;
    const wanted = cols && rows ? { cols, rows } : (this.lastSize ?? { cols: 120, rows: 30 });
    const size = { cols: Math.max(2, Math.floor(wanted.cols) || 120), rows: Math.max(1, Math.floor(wanted.rows) || 30) };
    const pty = loadPty().spawn(shellPath, ['-l'], { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env });
    const screen = new HeadlessTerminal({ cols: size.cols, rows: size.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const tab: Tab = {
      info: { id, title: shell, cwd, shell, pid: pty.pid, agent, createdAt: Date.now() },
      pty,
      screen,
      history: [],
      historyBytes: 0,
      integration: false,
      outputStart: undefined,
      osTitle: '',
      lastOutputAt: 0,
      waiters: new Set(),
      pending: null,
      ready: Promise.resolve(),
      markReady: () => undefined,
      seenOutput: false,
    };
    tab.ready = new Promise<void>((resolve) => {
      tab.markReady = resolve;
    });
    this.tabs.set(id, tab);
    this.wire(tab);
    this.emitTabs();
    return { ...tab.info };
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id);
    if (tab && tab.info.exitCode === undefined) tab.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.exitCode !== undefined) return;
    const c = Math.max(2, Math.floor(cols) || 0);
    const r = Math.max(1, Math.floor(rows) || 0);
    if (!c || !r) return;
    this.lastSize = { cols: c, rows: r };
    if (c === tab.screen.cols && r === tab.screen.rows) return;
    try {
      tab.pty.resize(c, r);
      tab.screen.resize(c, r);
    } catch (err) {
      console.warn('[terminal] resize failed:', err);
    }
  }

  /** Raw output so far (bounded), for replaying into a fresh xterm. */
  history(id: string): string {
    return this.must(id).history.join('');
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    this.settlePending(tab, { finished: tab.info.exitCode !== undefined, exitCode: tab.info.exitCode });
    try {
      if (tab.info.exitCode === undefined) tab.pty.kill();
    } catch {
      /* already gone */
    }
    tab.screen.dispose();
    this.emitTabs();
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  /** Sends Ctrl-C to the tab. Returns the command it interrupted, if one was known. */
  interrupt(id: string): string | undefined {
    const tab = this.must(id);
    if (tab.info.exitCode !== undefined) throw new Error(`The shell in ${id} has exited.`);
    const running = tab.info.running;
    tab.pty.write('\x03');
    return running;
  }

  /** The last `lines` screen lines, after waiting up to `waitMs` for new output. */
  async read(id: string, lines = 100, waitMs = 0): Promise<string> {
    const tab = this.must(id);
    if (waitMs > 0 && (await this.waitForOutput(tab, waitMs))) await delay(120);
    await this.settle(tab);
    const buf = tab.screen.buffer.active;
    const end = buf.baseY + buf.cursorY + 1;
    const out: string[] = [];
    for (let y = Math.max(0, end - Math.max(1, lines)); y < end; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
    return trimBlankLines(out).join('\n');
  }

  /**
   * Types the command into the tab and waits for it to finish (zsh integration) or for the timeout.
   * Without integration the command counts as done once output has been quiet for a moment.
   */
  async run(id: string, command: string, timeoutMs = DEFAULT_TIMEOUT): Promise<RunResult> {
    const tab = this.must(id);
    if (tab.info.exitCode !== undefined) throw new Error(`The shell in ${id} has exited; open a new tab (omit tab_id).`);
    if (tab.pending) throw new Error(`${id} is already waiting on a command.`);
    if (tab.info.running) throw new Error(`${id} is busy running "${tab.info.running}". Wait for it with terminal_read, interrupt it with terminal_stop, or use another tab.`);
    await Promise.race([tab.ready, delay(4000)]);
    await this.settle(tab);
    const startedAt = Date.now();
    return new Promise<RunResult>((resolve) => {
      const pending: Pending = {
        command,
        startedAt,
        promptRow: tab.screen.registerMarker(0),
        resolve,
        timer: setTimeout(() => void this.finishRun(tab, 'timeout'), Math.max(500, timeoutMs)),
      };
      tab.pending = pending;
      tab.pty.write(command.replace(/\r?\n$/, '') + '\r');
      if (!tab.integration) this.armQuiet(tab);
    });
  }

  // ---- internals ----

  private must(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) {
      const open = [...this.tabs.keys()];
      throw new Error(`No terminal tab ${id}. ${open.length ? `Open tabs: ${open.join(', ')}.` : 'No tabs are open; omit tab_id to open one.'}`);
    }
    return tab;
  }

  private environment(shell: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'Silo Harness';
    // The new name, and the old one for one release (a startup file may test it)
    env.SILO_HARNESS_TERMINAL = '1';
    env.OPEN_HARNESS_TERMINAL = '1';
    env.LANG ||= 'en_US.UTF-8';
    if (shell === 'zsh') {
      const dir = this.ensureShim();
      const user = process.env.ZDOTDIR || os.homedir();
      env.SILO_HARNESS_USER_ZDOTDIR = env.OPEN_HARNESS_USER_ZDOTDIR = user;
      env.SILO_HARNESS_ZDOTDIR = env.OPEN_HARNESS_ZDOTDIR = dir;
      env.ZDOTDIR = dir;
    }
    return env;
  }

  private ensureShim(): string {
    if (this.shimDir) return this.shimDir;
    const dir = path.join(this.opts.dataDir, 'zsh');
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = { '.zshenv': ZSHENV, '.zprofile': ZPROFILE, '.zshrc': ZSHRC };
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      let current = '';
      try {
        current = fs.readFileSync(p, 'utf8');
      } catch {
        /* missing */
      }
      if (current !== content) fs.writeFileSync(p, content);
    }
    this.shimDir = dir;
    return dir;
  }

  private wire(tab: Tab): void {
    const { screen, pty, info } = tab;
    screen.parser.registerOscHandler(133, (data) => {
      this.onMarker(tab, data);
      return true;
    });
    screen.parser.registerOscHandler(633, (data) => {
      if (data.startsWith('E;')) {
        try {
          info.running = Buffer.from(data.slice(2), 'base64').toString('utf8').trim() || '(command)';
        } catch {
          info.running = '(command)';
        }
        this.refreshTitle(tab);
        this.emitTabs();
      }
      return true;
    });
    screen.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m) {
        let p = m[1];
        try {
          p = decodeURIComponent(p);
        } catch {
          /* keep raw */
        }
        if (p !== info.cwd) {
          info.cwd = p;
          this.emitTabs();
        }
      }
      return true;
    });
    screen.onTitleChange((t) => {
      tab.osTitle = t.trim();
      this.refreshTitle(tab);
      this.emitTabs();
    });
    pty.onData((data) => {
      screen.write(data);
      tab.history.push(data);
      tab.historyBytes += data.length;
      while (tab.historyBytes > HISTORY_LIMIT && tab.history.length > 1) tab.historyBytes -= tab.history.shift()!.length;
      tab.lastOutputAt = Date.now();
      if (!tab.seenOutput) {
        tab.seenOutput = true;
        if (info.shell !== 'zsh') setTimeout(() => tab.markReady(), 400);
      }
      for (const w of tab.waiters) w();
      tab.waiters.clear();
      if (tab.pending && !tab.integration) this.armQuiet(tab);
      this.emit('data', info.id, data);
    });
    pty.onExit(({ exitCode }) => {
      tab.markReady();
      info.exitCode = exitCode;
      info.running = undefined;
      this.refreshTitle(tab);
      void this.settle(tab).then(() => {
        this.settlePending(tab, { finished: true, exitCode });
        this.emit('exit', info.id, exitCode);
        this.emitTabs();
      });
    });
  }

  private onMarker(tab: Tab, data: string): void {
    const [kind, arg] = data.split(';');
    if (kind === 'A') {
      // Prompt start: idle. (A D is missed when the shell was restarted mid-command.)
      tab.integration = true;
      tab.markReady();
      if (tab.info.running) {
        tab.info.running = undefined;
        this.refreshTitle(tab);
        this.emitTabs();
      }
    } else if (kind === 'C') {
      tab.integration = true;
      tab.outputStart = tab.screen.registerMarker(0);
      if (!tab.info.running) tab.info.running = tab.pending?.command ?? '(command)';
      this.refreshTitle(tab);
      this.emitTabs();
    } else if (kind === 'D') {
      const code = arg !== undefined && arg !== '' ? Number(arg) : undefined;
      tab.info.running = undefined;
      tab.osTitle = '';
      this.refreshTitle(tab);
      if (tab.pending) this.settlePending(tab, { finished: true, exitCode: Number.isFinite(code) ? code : undefined });
      tab.outputStart = undefined;
      this.emitTabs();
    }
  }

  private refreshTitle(tab: Tab): void {
    const { info } = tab;
    info.title = info.exitCode !== undefined ? info.shell : info.running ? tab.osTitle || programName(info.running) || info.shell : tab.osTitle || info.shell;
  }

  private emitTabs(): void {
    this.emit('tabs', this.list());
  }

  /** Parses everything the pty delivered so far (xterm writes are asynchronous). */
  private settle(tab: Tab): Promise<void> {
    return new Promise((resolve) => tab.screen.write('', () => resolve()));
  }

  private waitForOutput(tab: Tab, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        tab.waiters.delete(done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      tab.waiters.add(done);
    });
  }

  private armQuiet(tab: Tab): void {
    const p = tab.pending;
    if (!p) return;
    if (p.quietTimer) clearTimeout(p.quietTimer);
    p.quietTimer = setTimeout(() => void this.finishRun(tab, 'quiet'), QUIET_MS);
  }

  private async finishRun(tab: Tab, why: 'timeout' | 'quiet'): Promise<void> {
    const p = tab.pending;
    if (!p) return;
    if (why === 'quiet' && tab.integration) return; // a marker will finish it
    await this.settle(tab);
    if (tab.pending !== p) return;
    this.settlePending(tab, { finished: false, exitCode: undefined, quiet: why === 'quiet' });
  }

  /** Resolves the waiting run (if any) with the output captured so far. */
  private settlePending(tab: Tab, how: { finished: boolean; exitCode: number | undefined; quiet?: boolean }): void {
    const p = tab.pending;
    if (!p) return;
    tab.pending = null;
    clearTimeout(p.timer);
    if (p.quietTimer) clearTimeout(p.quietTimer);
    const output = this.capture(tab, p, how.finished, Boolean(how.quiet));
    p.resolve({ output, finished: how.finished, exitCode: how.exitCode, elapsedMs: Date.now() - p.startedAt, integration: tab.integration });
    p.promptRow?.dispose();
  }

  /** Screen lines from the start of the command's output to the cursor. */
  private capture(tab: Tab, p: Pending, finished: boolean, quiet: boolean): string {
    const buf = tab.screen.buffer.active;
    let from: number;
    if (tab.outputStart && !tab.outputStart.isDisposed) from = tab.outputStart.line;
    else if (p.promptRow && !p.promptRow.isDisposed) from = p.promptRow.line + 1; // skip the echoed command line
    else from = 0;
    const cursorRow = buf.baseY + buf.cursorY;
    // When finished, the cursor sits on the row the next prompt will use; while running, include the cursor's row.
    const to = (finished && buf.cursorX === 0) || quiet ? cursorRow : cursorRow + 1;
    const lines: string[] = [];
    for (let y = Math.max(0, from); y < to; y++) lines.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
    // zsh marks output that did not end in a newline with an inverse "%" (PROMPT_EOL_MARK) padded with spaces; drop the mark.
    let lastRow = lines.length - 1;
    while (lastRow >= 0 && !lines[lastRow]) lastRow--;
    if (finished && lastRow >= 0) {
      const last = lines[lastRow];
      const cell = buf.getLine(Math.max(0, from) + lastRow)?.getCell(last.length - 1);
      if (cell && /[%#]/.test(cell.getChars()) && cell.isInverse()) lines[lastRow] = last.slice(0, -1);
    }
    return trimBlankLines(lines).join('\n');
  }
}

function trimBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = 0;
  while (start < end && !lines[start].trim()) start++;
  return lines.slice(start, end);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "/Users/me/src" → "~/src" for a path in the home folder (by prefix), as the agent's terminal tools show paths */
export function tilde(p: string, home = os.homedir()): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Formats the tab list for the agent. */
export function describeTabs(tabs: TerminalTabInfo[], home = os.homedir()): string {
  if (!tabs.length) return 'No terminal tabs are open.';
  return tabs
    .map((t) => {
      const state = t.exitCode !== undefined ? `exited (${t.exitCode})` : t.running ? 'running' : 'idle';
      return `${t.id}  ${t.title}  ${state}  ${tilde(t.cwd, home)}${t.running ? `  (${t.running})` : ''}${t.agent ? '  [opened by the agent]' : ''}`;
    })
    .join('\n');
}
