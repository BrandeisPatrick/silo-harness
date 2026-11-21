// Moving things to the macOS Trash, never deleting them: every place the app sends a file or a folder there goes
// through trashItem. SILO_HARNESS_TRASH_DIR names a stand-in folder (the tests, so nothing of theirs lands in your
// Trash): the item is moved into it instead.
import fs from 'node:fs';
import path from 'node:path';
import { envVar } from './paths';

/** The stand-in for the Trash, when one is set */
export function trashStandIn(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = envVar('TRASH_DIR', env)?.trim();
  return v ? path.resolve(v) : null;
}

/** Moves `p` to the Trash (or the stand-in); a path that is not there is no error. */
export async function trashItem(p: string): Promise<void> {
  if (!fs.existsSync(p)) return;
  const stand = trashStandIn();
  if (stand) {
    fs.mkdirSync(stand, { recursive: true });
    fs.renameSync(p, path.join(stand, `${path.basename(p)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`));
    return;
  }
  const { shell } = require('electron') as typeof import('electron');
  await shell.trashItem(p);
}
