// Feature: chat cards. The window draws a card for each GitHub pull request a reply or a tool result names, and for
// each document the agent wrote (src/renderer/chat-cards.ts). This answers what the cards ask: a pull request's data
// from the GitHub CLI (chat-cards/pull-requests.ts; gh's own sign-in, never a token of ours), and opening or revealing
// a document (chat-cards/documents.ts). Contract: src/shared/chat-cards.ts.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { App } from './app';
import type { BrowserController } from './browser';
import type { DocumentOpened } from '../shared/chat-cards';
import { ARTIFACT_SCHEME } from './artifacts';
import { documentKind, documentViewerPath, MAX_VIEWER_BYTES } from './chat-cards/documents';
import { PullRequestLookup, type GhExec } from './chat-cards/pull-requests';
import { loginPath } from './mcp';

/** gh's output is a few KB; anything near this is not a pull request's JSON */
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Runs the GitHub CLI: `gh` on the user's login PATH (an app opened from the Dock has only the system's), or the
 * command SILO_HARNESS_GH names (the live tests point it at a fake). Never prompts, never colours, never updates.
 */
export function ghExec(): GhExec {
  return async (args) => {
    const command = process.env.SILO_HARNESS_GH || 'gh';
    const env = { ...process.env, PATH: await loginPath(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' };
    return new Promise<string>((resolve, reject) => {
      execFile(command, args, { env, timeout: 15_000, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
        else resolve(String(stdout ?? ''));
      });
    });
  };
}

/** An absolute path to a file that exists, or an error that says what is wrong. */
function existingFile(p: unknown): string {
  const file = String(p ?? '');
  if (!file || !path.isAbsolute(file)) throw new Error('Not a file path');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`${path.basename(file)} is no longer there`);
  }
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  return file;
}

export function setupChatCards(app: App, browser: () => BrowserController | null, opts: { exec?: GhExec } = {}): { lookup: PullRequestLookup; dispose(): void } {
  const lookup = new PullRequestLookup({ exec: opts.exec ?? ghExec() });

  /** Markdown and text in the viewer, HTML as itself, in the Browser pane; false when the pane cannot take it. */
  async function showInPane(file: string): Promise<boolean> {
    const controller = browser();
    if (!controller) return false;
    const kind = documentKind(file);
    let url: string;
    if (kind === 'html') url = `file://${encodeURI(file)}`;
    else if ((kind === 'markdown' || kind === 'text') && fs.statSync(file).size <= MAX_VIEWER_BYTES) url = `${ARTIFACT_SCHEME}://view/${documentViewerPath(file)}`;
    else return false;
    // The user's own navigation, like the URL bar: no agent stamp
    await controller.userNavigate(url);
    return true;
  }

  const disposers = [
    app.rpc.handle('cards.pullRequest', (url) => lookup.get(String(url ?? ''))),
    app.rpc.handle('cards.openDocument', async (p, o): Promise<DocumentOpened> => {
      const file = existingFile(p);
      if (o?.external !== true && (await showInPane(file))) return 'pane';
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      return 'external';
    }),
    app.rpc.handle('cards.revealDocument', (p) => {
      shell.showItemInFolder(existingFile(p));
    }),
  ];
  return {
    lookup,
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}
