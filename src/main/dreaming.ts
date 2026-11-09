// Feature: Dreaming. A dream is a background session that reads what happened in recent sessions and proposes skills,
// mods and memory lines; its mode decides when a proposal is applied, and the app applies it. Wires the service into
// the app: service, RPC, the dream's tools and prompt section, /dream, the daily timer.

import path from 'node:path';
import type { App } from './app';
import type { DreamMode } from '../shared/dreaming';
import { Dreaming, DreamError, type DreamingOptions } from './dreaming/service';
import { dreamTools } from './dreaming/tools';
import { normalizeDreaming } from './config';

export { Dreaming, DreamError, latestOccurrence, nextOccurrence, waitingOf } from './dreaming/service';
export type { DreamingOptions } from './dreaming/service';

const MODE_LINES: Record<DreamMode, string> = {
  auto: 'This dream runs in Auto mode: the app applies each proposal the moment you make it (a new mod still stays off until the user turns it on). End with a reply that lists exactly what was applied, and where.',
  approve: 'This dream runs in Approve mode: each proposal waits for the user to apply or dismiss it, so finish your whole review without stopping to ask, then end with a short report.',
  plan: 'This dream runs in Plan mode: nothing is applied; when you end, your proposals become one plan the user approves as a whole. If the user answers in this session, change the plan with withdraw_proposal and new proposals (replaces), then end again.',
};

/** What a dream session is told (only dream sessions get it: it is a section for sessions with a tool set of their own). */
export function dreamPrompt(cwd: string, mode: DreamMode, tools: string[]): string {
  const has = (t: string) => tools.includes(t);
  const kinds = [
    has('propose_skill') && '- propose_skill: a procedure the user asked for more than once (in two or more sessions, or the same steps spelled out again) becomes a skill.',
    has('propose_memory') && "- propose_memory: a durable preference, a correction the user had to make, or a fact about this project becomes lines in the instructions file (the project's, or the user's own for every project); lines there that the sessions show to be wrong or outdated can be removed.",
    has('propose_mod') && '- propose_mod: a view or a status the user keeps asking for becomes a mod (a small panel); it stays off until the user turns it on.',
  ].filter(Boolean);
  return [
    '## Dreaming',
    `This session is a dream: a quiet review of the user's recent sessions in ${cwd}, to improve how you work for this user. Its first message is a digest of those sessions that the app put together; history_read, history_search, session_list and session_read look further into them, and read_file, glob, grep and list_directory look at the project.`,
    'You change nothing yourself. You propose, and the app applies:',
    ...kinds,
    '- withdraw_proposal takes one of your proposals back; `replaces` on a propose tool swaps one for a better one.',
    MODE_LINES[mode],
    'The bar:',
    "- Propose only what the logs support. Quote the evidence in why (the user's own words, and how often it came up) and list the sessions it is based on by their ids.",
    '- Prefer no proposal to a speculative one, and fewer to more: at most about five in a dream. A dream with no proposals is a good result; then say plainly that there was nothing worth proposing.',
    '- Do not propose what exists already (the digest lists the skills, mods and instructions there are). To change one of them, set changes_existing and say what changes and why.',
    '- One-off tasks, and the content of the work itself (a bug that was fixed, a file that was written), are not memory. Memory is what should change how you work next time.',
    '- Never copy secrets out of the logs into a skill, a mod or memory: no keys, tokens, passwords, or URLs with credentials in them.',
    'End with a short plain report: what you proposed and why, in a few lines.',
  ].join('\n');
}

/** `opts` is for tests: an injected clock, timer, store and notification. Returns the service (also provided as 'dreaming'). */
export function setupDreaming(app: App, opts: DreamingOptions = {}): Dreaming {
  const svc = new Dreaming(app, opts);
  app.provide('dreaming', svc);
  const state = () => svc.state();
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof DreamError) throw new Error(err.message.charAt(0).toUpperCase() + err.message.slice(1));
      throw err;
    }
  };

  app.rpc.handle('dreaming.get', state);
  app.rpc.handle('dreaming.set', (patch) => {
    app.updateConfig((c) => ({ ...c, dreaming: normalizeDreaming({ ...c.dreaming, ...(patch ?? {}) }) }));
    return state();
  });
  app.rpc.handle('dreaming.run', (cwd) =>
    guard(() => {
      // From the window, by hand: every project with new activity, or the one chosen on the Dreaming page (/dream is 'command')
      svc.start('manual', typeof cwd === 'string' && cwd ? cwd : undefined);
      return state();
    }),
  );
  app.rpc.handle('dreaming.stop', () => {
    svc.stop();
    return state();
  });
  app.rpc.handle('dreaming.list', () => state().dreams);
  app.rpc.handle('dreaming.projects', () => svc.projectList());
  app.rpc.handle('dreaming.apply', (id) => guard(() => svc.apply(String(id))));
  app.rpc.handle('dreaming.dismiss', (id) => guard(() => svc.dismiss(String(id))));
  app.rpc.handle('dreaming.applyAll', (id) => guard(() => svc.applyAll(String(id))));
  app.rpc.handle('dreaming.revert', (id) => guard(() => svc.revert(String(id))));

  // Offered only to dream sessions (scoped), and only those their tool set names
  for (const tool of dreamTools(app, svc)) app.tools.register(tool);
  app.prompt.add(
    'dreaming',
    ({ sessionId }) => {
      const s = app.store.get(sessionId);
      const dream = s?.dream ? svc.dreamOf(sessionId) : undefined;
      if (!s?.dream || !dream) return '';
      return dreamPrompt(dream.cwd, dream.mode, s.tools ?? []);
    },
    { restricted: true },
  );

  app.commands.register({
    name: 'dream',
    description: "Dream now about this session's project: review its recent sessions and suggest skills, mods and memory",
    source: 'app',
    run: (_args, ctx) => {
      const cwd = app.store.get(ctx.sessionId)?.cwd || app.config().workingDirectory;
      const where = cwd.replace(process.env.HOME ?? '\u0000', '~');
      try {
        const { projects } = svc.start('command', cwd);
        if (!projects.length) return { notice: `Nothing new to dream about in ${where} since its last dream.` };
        return { notice: `Dreaming about ${where} in the background (${path.basename(cwd)}). Its suggestions show on the Dreaming page and in the dream's session.` };
      } catch (err) {
        return { error: err instanceof Error ? err.message.charAt(0).toUpperCase() + err.message.slice(1) : String(err) };
      }
    },
  });

  svc.attach(opts);
  app.onQuit(() => svc.dispose());
  return svc;
}
