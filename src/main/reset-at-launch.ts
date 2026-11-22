// Runs when index.ts loads, right after carry-over.ts and before any other module reads the data folder: carries out
// a reset the last instance asked for (reset.ts). What goes is moved aside here and sent to the Trash once the app is
// ready (finishReset in index.ts).
// Nothing here may keep the app from starting: on any error the mark goes, the app starts as usual and says so once.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { RESET_MARK, resetNotices, stageReset } from './reset';

const userData = app.getPath('userData');
try {
  stageReset(userData, (line) => console.log(line));
} catch (err) {
  console.log(`[reset] the reset could not be carried out (${err instanceof Error ? err.message : String(err)}); starting as usual`);
  try {
    fs.rmSync(path.join(userData, RESET_MARK), { force: true });
  } catch {
    /* it stays; the next launch meets the same error and starts as usual again */
  }
  resetNotices.push('The reset could not be carried out, so the app started as it was. Try it again from Settings → Developer.');
}
