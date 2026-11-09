// Where the app keeps the files a person edits by hand: settings.json, skills, mods and the user-level instructions.
// The app was called Open Harness before it was Silo Harness: the old folder names are still found when the new ones
// are missing, and the first launch under the new name moves ~/.open-harness to ~/.silo-harness (see migrate.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The user-level config folder's name in the home folder, and the one it had before the rename */
export const CONFIG_DIR_NAME = '.silo-harness';
export const OLD_CONFIG_DIR_NAME = '.open-harness';

/** The project folder's name, and the one it had before the rename */
export const PROJECT_DIR_NAME = '.silo-harness';
export const OLD_PROJECT_DIR_NAME = '.open-harness';

const exists = (p: string): boolean => fs.existsSync(p);

/**
 * The config folder an override names: SILO_HARNESS_CONFIG_DIR, else OPEN_HARNESS_CONFIG_DIR (its name before the
 * rename), else none. Tests point it at a temp folder so they never read or write the real one.
 */
export function configDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.SILO_HARNESS_CONFIG_DIR?.trim() || env.OPEN_HARNESS_CONFIG_DIR?.trim();
  return v ? path.resolve(v) : null;
}

/**
 * The folder a session works in when none was chosen: ~/Documents/Silo, made at launch so it is always there.
 * SILO_HARNESS_WORK_DIR overrides it; with a config-dir override (the tests) it sits inside that folder, so a test
 * never writes to the real Documents.
 */
export function defaultWorkDir(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const own = env.SILO_HARNESS_WORK_DIR?.trim();
  if (own) return path.resolve(own);
  const override = configDirOverride(env);
  return override ? path.join(override, 'Silo') : path.join(home, 'Documents', 'Silo');
}

/**
 * The user-level config folder: the override when one is set, else ~/.silo-harness, else ~/.open-harness when only
 * that one is there (the move at launch failed, or the app has not started since the rename), else ~/.silo-harness
 * for a new one. Read on every call, so a test can set the variable late.
 */
export function configDir(home: string = os.homedir()): string {
  const override = configDirOverride();
  if (override) return override;
  const next = path.join(home, CONFIG_DIR_NAME);
  const old = path.join(home, OLD_CONFIG_DIR_NAME);
  return !exists(next) && exists(old) ? old : next;
}

/**
 * The config folder of a project: <project>/.silo-harness when it exists, else <project>/.open-harness when that
 * exists, else <project>/.silo-harness for anything new.
 */
export function projectConfigDir(cwd: string): string {
  const next = path.join(cwd, PROJECT_DIR_NAME);
  const old = path.join(cwd, OLD_PROJECT_DIR_NAME);
  return !exists(next) && exists(old) ? old : next;
}

/** "~/.silo-harness/SILOHARNESS.md" for a path in the home folder, the absolute path otherwise */
export function tildeLabel(p: string, home: string = os.homedir()): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : p;
}

/** An environment variable under its new name (SILO_HARNESS_…), else under its name before the rename (OPEN_HARNESS_…) */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[`SILO_HARNESS_${name}`]?.trim();
  if (v) return v;
  return env[`OPEN_HARNESS_${name}`]?.trim() || undefined;
}
