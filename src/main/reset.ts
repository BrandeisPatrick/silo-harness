// Full reset and Reset settings (Settings → Developer → Reset).
//
//   Full reset       the app back to its first launch: everything in the data folder (sessions and history, logs, the
//                    browser's data and sign-ins, learned answers, the app's saved settings) and your mods go to the
//                    Trash; with the box ticked, your settings.json (providers and keys) too. Projects and their files
//                    and your skills are not touched.
//   Reset settings   only the app's saved settings (config.json) go: back to defaults; sessions stay.
//
// A click leaves a mark in the data folder and relaunches. The next launch, before anything reads the data folder
// (reset-at-launch.ts is imported right after carry-over.ts), moves what goes into one hidden folder of the data folder
// (renames: nothing is deleted), and once the app is ready sends that folder to the Trash (trash.ts). If the Trash
// cannot take it, the folder stays and the next launch tries again.
//
// Only a click in the main window starts either: an IPC channel of its own, not an RPC (the phone remote, a mod's
// bridge, hooks and the agent's tools reach RPCs or nothing), whose sender must be the main window's own top frame.
// SILO_HARNESS_NO_RELAUNCH makes the app quit instead of relaunching (the tests relaunch it themselves).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from './app';
import { configDir, envVar } from './paths';
import { trashItem } from './trash';

export type ResetKind = 'full' | 'settings';

export interface ResetPlan {
  kind: ResetKind;
  /** Full reset only: your settings.json goes too */
  settingsJson: boolean;
  at: number;
}

/** The mark a reset leaves in the data folder for the next launch */
export const RESET_MARK = '.silo-reset.json';
/** The hidden folder of the data folder the next launch moves what goes into */
export const STAGE_PREFIX = '.silo-reset-';
const PLAN_FILE = 'reset-plan.json';
/** How long a reset waits for running sessions to stop before it relaunches anyway */
const STOP_WAIT_MS = 5000;

/**
 * What stays in the data folder at a full reset: the mark, the folders on their way to the Trash, and the files of the
 * running instance itself (Chromium's lock and, in the tests, the port it listens on).
 */
const stays = (name: string) => name === RESET_MARK || name.startsWith(STAGE_PREFIX) || name.startsWith('Singleton') || name === 'DevToolsActivePort';

/** What this app always leaves in its data folder: a folder with none of them is not its own */
const OWN = ['config.json', 'sessions', 'Local State'];

/** What the window says once it is up: a reset that was refused or could not finish at this launch */
export const resetNotices: string[] = [];

/**
 * Why a reset may not sweep `userData`, or null when it may: the folder must look like this app's own and lie in your
 * home folder (or your temp folder, where a test's profile lives).
 */
export function resetRefusal(userData: string): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const dir = real(userData);
  if (![os.homedir(), os.tmpdir()].some((root) => dir.startsWith(real(root) + path.sep))) return `The reset was refused: the data folder (${userData}) is not in your home folder.`;
  if (!OWN.some((n) => fs.existsSync(path.join(userData, n)))) return `The reset was refused: the data folder (${userData}) does not look like this app's own.`;
  return null;
}

function parsePlan(raw: string): ResetPlan | null {
  try {
    const p = JSON.parse(raw) as Partial<ResetPlan>;
    if (p.kind !== 'full' && p.kind !== 'settings') return null;
    return { kind: p.kind, settingsJson: p.kind === 'full' && p.settingsJson === true, at: Number(p.at) || Date.now() };
  } catch {
    return null;
  }
}

/** Asks the next launch for a reset (the click's part, before the relaunch). */
export function markReset(userData: string, plan: ResetPlan): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, RESET_MARK), JSON.stringify(plan), { mode: 0o600 });
}

/**
 * At launch, before anything reads the data folder: carries out the reset the last instance asked for. Moves what goes
 * into a hidden folder of the data folder, with the plan beside it; finishReset sends it to the Trash. Your mods and
 * (when asked) settings.json move there too, so this launch reads neither. Returns the plan, or null without one.
 */
export function stageReset(userData: string, log: (line: string) => void = () => {}, configFolder: string = configDir()): ResetPlan | null {
  const mark = path.join(userData, RESET_MARK);
  let raw: string;
  try {
    raw = fs.readFileSync(mark, 'utf8');
  } catch {
    return null;
  }
  const plan = parsePlan(raw);
  if (!plan) {
    log('[reset] the reset mark is not one this app writes; it was left out');
    fs.rmSync(mark, { force: true });
    return null;
  }
  const refused = resetRefusal(userData);
  if (refused) {
    log(`[reset] ${refused}`);
    fs.rmSync(mark, { force: true });
    resetNotices.push(`${refused} Nothing was moved.`);
    return null;
  }
  const stage = path.join(userData, `${STAGE_PREFIX}${plan.at}`);
  fs.mkdirSync(stage, { recursive: true });
  // Your config folder (settings.json, skills, mods) may sit inside the data folder (a test's profile, a folder you
  // chose): the entry that holds it stays, and only its mods (and settings.json when asked) go, as below
  // Compared as real paths: /var and /private/var are one folder on macOS
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const cfg = real(configFolder);
  const holdsConfig = (n: string) => {
    const p = real(path.join(userData, n));
    return cfg === p || cfg.startsWith(p + path.sep);
  };
  const moves: [string, string][] =
    plan.kind === 'full'
      ? fs
          .readdirSync(userData)
          .filter((n) => !stays(n) && !holdsConfig(n))
          .map((n) => [path.join(userData, n), path.join(stage, n)])
      : [[path.join(userData, 'config.json'), path.join(stage, 'config.json')]];
  if (plan.kind === 'full') {
    moves.push([path.join(configFolder, 'mods'), path.join(stage, 'your-mods')]);
    if (plan.settingsJson) moves.push([path.join(configFolder, 'settings.json'), path.join(stage, 'your-settings.json')]);
  }
  /** What could not be moved into the folder (another volume): sent to the Trash on its own once the app is ready */
  const later: string[] = [];
  let moved = 0;
  for (const [from, to] of moves) {
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
      moved++;
    } catch (err) {
      later.push(from);
      log(`[reset] could not move ${path.basename(from)} aside (${(err as NodeJS.ErrnoException).code ?? 'error'}); it goes to the Trash on its own`);
    }
  }
  fs.writeFileSync(path.join(stage, PLAN_FILE), JSON.stringify({ ...plan, later }));
  fs.rmSync(mark, { force: true });
  log(`[reset] ${plan.kind === 'full' ? 'full reset' : 'settings reset'}: ${moved} item(s) moved aside, to the Trash once the app is ready`);
  return plan;
}

/** Once the app is ready: every folder a reset moved aside (and what could not be moved) goes to the Trash. */
export async function finishReset(userData: string, log: (line: string) => void = () => {}): Promise<number> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(userData).filter((n) => n.startsWith(STAGE_PREFIX));
  } catch {
    return 0;
  }
  let sent = 0;
  for (const n of names) {
    const stage = path.join(userData, n);
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(stage, PLAN_FILE), 'utf8')) as { later?: unknown };
      for (const p of Array.isArray(plan.later) ? plan.later : []) if (typeof p === 'string') await trashItem(p);
    } catch {
      /* no plan: the folder alone */
    }
    try {
      await trashItem(stage);
      sent++;
    } catch (err) {
      log(`[reset] could not move ${n} to the Trash (${err instanceof Error ? err.message : String(err)}); trying again at the next launch`);
    }
  }
  if (sent) log(`[reset] moved ${sent} folder(s) to the Trash`);
  return sent;
}

/** Whether a request comes from the main window's own page: its webContents, its top frame, the app's own file. */
export function fromMainWindow(sender: unknown, frame: { url?: string } | null | undefined, win: { webContents: { mainFrame?: unknown } } | null | undefined): boolean {
  if (!win || !frame || sender !== win.webContents || frame !== win.webContents.mainFrame) return false;
  return String(frame.url ?? '').startsWith('file:');
}

/** The 'app:reset' channel: only the main window's page, after the user confirmed in it. */
export function setupReset(app: App): () => void {
  const electron = require('electron') as typeof import('electron');
  let busy = false;
  electron.ipcMain.handle('app:reset', async (e, kind: unknown, opts: unknown) => {
    if (!fromMainWindow(e.sender, e.senderFrame, app.window())) throw new Error('A reset starts only from Settings in the app window.');
    if (kind !== 'full' && kind !== 'settings') throw new Error('Unknown reset.');
    if (busy) return { relaunching: true };
    const refused = resetRefusal(app.userData);
    if (refused) throw new Error(refused);
    busy = true;
    const plan: ResetPlan = { kind, settingsJson: kind === 'full' && Boolean((opts as { settingsJson?: unknown } | null)?.settingsJson), at: Date.now() };
    // Running sessions stop first (a run's last act is to save its session, which the next launch moves aside)
    const runtime = app.runtime;
    for (const id of runtime.running()) runtime.stop(id);
    const until = Date.now() + STOP_WAIT_MS;
    while (runtime.running().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    markReset(app.userData, plan);
    console.log(`[reset] ${kind === 'full' ? 'full reset' : 'settings reset'} asked from Settings; ${envVar('NO_RELAUNCH') ? 'quitting' : 'relaunching'}`);
    // After the answer has reached the window
    setTimeout(() => {
      if (!envVar('NO_RELAUNCH')) electron.app.relaunch();
      electron.app.quit();
    }, 100);
    return { relaunching: true };
  });
  const dispose = () => electron.ipcMain.removeHandler('app:reset');
  app.onQuit(dispose);
  return dispose;
}
