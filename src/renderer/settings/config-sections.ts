// General, Permissions and Context: the sections that are rows over the config (Models is in models-section.ts).

import type { AppConfig, PermissionMode } from '../../shared/types';
import type { CliStatus } from '../../shared/providers';
import type { PowerStatus } from '../../shared/schedules';
import { h } from '../dom.js';
import { MODES } from '../modes.js';
import { onPush } from '../rpc.js';
import { COMPACT_AT, KEEP_AWAKE, nearestCompactStep, parseInteger, TOOL_ACTIVITY, TOOL_SET, type Parsed } from './model.js';
import { actions, button, group, row, sectionTitle, switchControl, tildePath } from './ui.js';
import type { Ctx, Section } from './ctx.js';
import { learnedAnswers, recentlyBlocked } from '../auto-blocked.js';
import { homeDir } from '../home.js';

export function generalSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('General'));

  const folder = row({ id: 'workingDirectory', title: 'Working folder', desc: '', keywords: 'directory project cwd path folder', field: 'workingDirectory' }, button('Change…', () => void ctx.chooseFolder(), { icon: 'folder' }));
  folder.descEl.classList.add('sp-path');

  const awake = ctx.segField({
    id: 'keepAwake',
    title: 'Keep awake',
    desc: 'Stop this Mac from sleeping.',
    keywords: 'sleep caffeinate power battery lid',
    field: 'keepAwake',
    choices: KEEP_AWAKE,
  });
  const awakeBase = 'Stop this Mac from sleeping.';
  const showPower = (p: PowerStatus | null) => awake.setDesc(p?.active ? `${awakeBase} Keeping it awake now.` : awakeBase);
  onPush('power:changed', (p) => showPower(p));

  // The command-line tool: where it is, and a link on the PATH
  const cliInstall = button('Install', () => void cliAction('cli.install', cliInstall), { icon: 'terminal' });
  const cliRemove = button('Remove', () => void cliAction('cli.uninstall', cliRemove));
  const cli = row({ id: 'cli', title: 'Command line tool', desc: '', keywords: 'cli command terminal shell silo open-harness path install agent claude code provider' }, actions(cliInstall, cliRemove));
  cli.descEl.classList.add('sp-path');
  const showCli = (st: CliStatus | null) => {
    if (!st) {
      cli.el.hidden = true;
      return;
    }
    cli.el.hidden = false;
    const where = st.installed ? `silo → ${tildePath(st.command)}` : tildePath(st.command);
    const extra = !st.available
      ? '. Not in this copy of the app.'
      : st.conflict
        ? `. ${st.conflict}`
        : st.installed && !st.onPath
          ? `. ${tildePath(st.link.replace(/\/silo$/, ''))} is not on your PATH; add it in your shell profile.`
          : st.installed
            ? `. Linked as ${tildePath(st.link)}.`
            : `. Install links it in ${tildePath(st.link.replace(/\/silo$/, ''))}.`;
    cli.setDesc(where + extra);
    cli.descEl.title = st.command;
    cliInstall.hidden = st.installed;
    cliInstall.disabled = !st.available || Boolean(st.conflict);
    cliRemove.hidden = !st.installed;
  };
  async function cliAction(method: 'cli.install' | 'cli.uninstall', btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      showCli(await ctx.call(method));
      cli.problem(null);
      cli.saved();
    } catch (err) {
      cli.problem(ctx.cleanError(err));
    } finally {
      btn.disabled = false;
    }
  }

  // Absent means on, so the switch reads `!== false` (ctx.switchField reads absent as off)
  const updatesOn = (cfg: AppConfig) => cfg.checkForUpdates !== false;
  const updatesSwitch = switchControl(updatesOn(ctx.config()), (on, input) => void ctx.save(updatesRow, 'checkForUpdates', on).then((ok) => !ok && (input.checked = updatesOn(ctx.config()))));
  const updatesRow = row({ id: 'checkForUpdates', title: 'Check for updates', desc: 'Once a day, from GitHub.', keywords: 'update updates new version release download github', field: 'checkForUpdates' }, updatesSwitch);
  updatesRow.el.classList.add('clickable');

  el.append(
    group(
      null,
      folder,
      awake,
      ctx.segField({
        id: 'toolActivity',
        title: 'Tool activity',
        desc: 'How tool calls show in the conversation.',
        keywords: 'tools calls rows fold collapse group summary quiet verbose',
        field: 'toolActivity',
        choices: TOOL_ACTIVITY,
      }),
      cli,
      ctx.switchField({ id: 'notifications', title: 'Notifications', desc: 'Notify when a run finishes or needs approval.', keywords: 'alert notify banner sound', field: 'notifications' }),
      updatesRow,
      ctx.switchField({ id: 'autoTitles', title: 'Generated titles', desc: 'Name a session from its first exchange.', keywords: 'session name rename title', field: 'autoTitles' }),
      ctx.textField({ id: 'maxTurns', inputId: 'maxTurns', title: 'Max tool turns', desc: 'Model calls per request before it stops to ask.', keywords: 'limit steps iterations', field: 'maxTurns', type: 'number', width: 96, parse: (t) => parseInteger(t, 1, 500) }),
      ctx.textField({
        id: 'systemPromptExtra',
        inputId: 'systemPromptExtra',
        title: 'Extra system prompt',
        desc: 'Added to every request.',
        keywords: 'instructions rules prompt',
        field: 'systemPromptExtra',
        multiline: true,
        placeholder: 'House rules, coding style, project context…',
        parse: (t) => ({ ok: true, value: String(t ?? '') }),
      }),
    ),
  );

  return {
    id: 'general',
    el,
    sync(cfg) {
      updatesSwitch.checked = updatesOn(cfg);
      folder.setDesc(tildePath(cfg.workingDirectory));
      folder.descEl.title = cfg.workingDirectory;
    },
    async load() {
      try {
        showPower(await ctx.call('power.status'));
      } catch {
        showPower(null);
      }
      try {
        showCli(await ctx.call('cli.status'));
      } catch {
        showCli(null);
      }
      return 'ok';
    },
  };
}

/** sandbox.allowWrite as typed: one folder per line, absolute or ~/…, never /, ~ or a folder above the home folder */
export function parseFolders(text: string): Parsed<string[]> {
  const list = [...new Set(String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean))];
  const home = homeDir().replace(/\/+$/, '');
  for (const f of list) {
    const bare = f.replace(/\/+$/, '');
    if (!bare || bare === '~' || bare === '/Users' || (home && (home === bare || home.startsWith(`${bare}/`)))) return { ok: false, error: `${f} would make your whole home folder writable.` };
    if (!f.startsWith('/') && !f.startsWith('~/')) return { ok: false, error: `${f}: write a full path, such as ~/scratch.` };
  }
  return { ok: true, value: list };
}

export function permissionsSection(ctx: Ctx, rulesEl: HTMLElement): Section {
  const el = h('section', {}, sectionTitle('Permissions'));
  const order: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];
  const SHORT: Record<PermissionMode, string> = { ask: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
  const mode = ctx.selectField({
    id: 'permissionMode',
    inputId: 'permissionMode',
    title: 'Default mode',
    desc: 'The mode each session starts in.',
    keywords: 'ask accept edits auto plan bypass approval approve',
    field: 'permissionMode',
    width: 340,
    choices: order.map((m) => ({ value: m, label: `${SHORT[m]} · ${MODES[m].desc}` })),
    read: (v) => (order.includes(v as PermissionMode) ? (v as PermissionMode) : 'ask'),
  });
  const rules = row({ id: 'rules', title: 'Rules', desc: 'What runs, asks or is refused in this project.', keywords: 'always allow ask deny rules project commands programs mcp edits bash read write pattern', full: true }, rulesEl);
  rulesEl.classList.add('sp-embedded');
  const blocked = recentlyBlocked(ctx);
  const learned = learnedAnswers(ctx);
  const learn = ctx.switchField({ id: 'autoMode-learn', title: 'Learn from my answers', desc: 'Auto mode decides like cases the way you did.', keywords: 'auto mode learn remember preferences answers approvals', field: 'autoMode.learn' });
  const forget = row({ id: 'auto-learned', title: 'What it learned', keywords: 'auto mode learned answers forget all' }, learned.forgetAll);
  // The shell sandbox: on, this Mac's own ports, more folders it may write; one plain line when this Mac cannot run it
  const SANDBOX_DESC = 'Commands that stay in the project and temp folders run without the check.';
  const sandbox = ctx.switchField({ id: 'sandbox-enabled', title: 'Run commands in a sandbox', desc: SANDBOX_DESC, keywords: 'sandbox shell bash commands auto mode check contained seatbelt plan', field: 'sandbox.enabled' });
  const loopback = ctx.switchField({ id: 'sandbox-loopback', title: 'Local ports', desc: 'Sandboxed commands may reach servers on this Mac, except databases, Docker and Ollama.', keywords: 'sandbox localhost loopback ports network servers tests', field: 'sandbox.loopback' });
  const folders = ctx.textField({
    id: 'sandbox-allowWrite',
    inputId: 'sandbox-allowWrite',
    title: 'Folders commands may also write',
    desc: 'One per line.',
    keywords: 'sandbox folders write allow paths extra',
    field: 'sandbox.allowWrite',
    multiline: true,
    mono: true,
    placeholder: '~/scratch',
    format: (v) => (Array.isArray(v) ? v.join('\n') : ''),
    parse: parseFolders,
  });
  let probed: boolean | null = null;
  const showSandbox = (cfg: AppConfig) => {
    const on = cfg.sandbox?.enabled === true;
    loopback.el.hidden = !on;
    folders.el.hidden = !on;
    if (on && probed === null) {
      probed = true;
      ctx
        .call('auto.sandbox')
        .then((r) => sandbox.setDesc(r.available ? SANDBOX_DESC : 'This Mac cannot run the sandbox: commands are checked as before.'))
        .catch(() => undefined);
    }
  };
  el.append(group(null, mode), group('This project', rules), group('Auto mode', sandbox, loopback, folders, learn, forget, learned.el), group('Recently blocked', blocked.el));
  return {
    id: 'permissions',
    el,
    sync: showSandbox,
    async load() {
      showSandbox(ctx.config());
      await Promise.all([blocked.refresh(), learned.refresh()]);
      return 'ok';
    },
  };
}

export function contextSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Context'));
  el.append(
    group(
      null,
      ctx.switchField({ id: 'autoCompact', title: 'Auto-compact', desc: 'Summarise the conversation when the context fills up.', keywords: 'compaction summary summarise', field: 'autoCompact' }),
      ctx.selectField({
        id: 'compactThreshold',
        inputId: 'compactThreshold',
        title: 'Compact at',
        desc: 'How full the context gets before summarising.',
        keywords: 'threshold percent compaction',
        field: 'compactThreshold',
        width: 120,
        choices: COMPACT_AT.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
        read: (v) => nearestCompactStep(v),
      }),
      ctx.segField({
        id: 'toolSet',
        title: 'Tools offered to the model',
        desc: 'Automatic adds tools like the browser when a task needs them; Essential suits small windows.',
        keywords: 'tools schedule sub-session subagent mods small window local model overhead essential all automatic',
        field: 'toolSet',
        choices: TOOL_SET,
      }),
      ctx.switchField({ id: 'pruneToolResults', title: 'Trim old tool output', desc: 'Shorten old tool results before summarising.', keywords: 'prune shorten compaction', field: 'pruneToolResults' }),
      ctx.switchField({ id: 'sendScreenshotsToModel', title: 'Send browser screenshots to the model', desc: 'Needs a model with vision.', keywords: 'vision images browser', field: 'sendScreenshotsToModel' }),
    ),
  );
  return { id: 'context', el };
}
