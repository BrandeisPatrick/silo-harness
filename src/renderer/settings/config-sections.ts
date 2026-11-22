// General and Permissions: the sections that are rows over the config (Models is in models-section.ts), and the rows
// that were Settings → Context, which Models → Advanced holds now.

import type { AppConfig, PermissionMode } from '../../shared/types';
import type { PowerStatus } from '../../shared/schedules';
import { h } from '../dom.js';
import { MODES } from '../modes.js';
import { onPush } from '../rpc.js';
import { COMPACT_AT, KEEP_AWAKE, nearestCompactStep, parseInteger, TOOL_ACTIVITY, TOOL_SET, type Parsed } from './model.js';
import { advanced, button, card, pathDesc, row, sectionTitle, switchControl, type Row } from './ui.js';
import type { Ctx, Section } from './ctx.js';
import { learnedAnswers, recentlyBlocked } from '../auto-blocked.js';
import { homeDir } from '../home.js';

export function generalSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('General'));

  const folder = row({ id: 'workingDirectory', title: 'Working folder', desc: '', keywords: 'directory project cwd path folder', field: 'workingDirectory' }, button('Change…', () => void ctx.chooseFolder(), { icon: 'folder' }));

  const AWAKE = 'Stop this Mac from sleeping.';
  const awake = ctx.segField({ id: 'keepAwake', title: 'Keep awake', desc: AWAKE, keywords: 'sleep caffeinate power battery lid', field: 'keepAwake', choices: KEEP_AWAKE });
  const showPower = (p: PowerStatus | null) => awake.setDesc(p?.active ? 'Keeping this Mac awake now.' : AWAKE);
  onPush('power:changed', (p) => showPower(p));

  // Absent means on, so the switch reads `!== false` (ctx.switchField reads absent as off)
  const updatesOn = (cfg: AppConfig) => cfg.checkForUpdates !== false;
  const updatesSwitch = switchControl(updatesOn(ctx.config()), (on, input) => void ctx.save(updatesRow, 'checkForUpdates', on).then((ok) => !ok && (input.checked = updatesOn(ctx.config()))));
  // The version is its description (About was a page of its own before)
  const updatesRow = row({ id: 'checkForUpdates', title: 'Check for updates', desc: '', keywords: 'update updates new version release download github once a day silo harness about macos', field: 'checkForUpdates' }, updatesSwitch);
  updatesRow.el.classList.add('clickable');
  const keys = row({ id: 'about-shortcuts', title: 'Keyboard shortcuts', keywords: 'keys hotkeys sheet about' }, button('Show', () => ctx.openShortcuts(), { icon: 'keyboard' }));

  el.append(
    card(null, folder),
    card(
      null,
      ctx.switchField({ id: 'notifications', title: 'Notifications', desc: 'When a run finishes or needs you.', keywords: 'alert notify banner sound approval', field: 'notifications' }),
      awake,
      updatesRow,
      keys,
    ),
    advanced(
      'general',
      card(
        null,
        ctx.switchField({ id: 'autoTitles', title: 'Generated titles', desc: 'Name sessions from their first exchange.', keywords: 'session name rename title', field: 'autoTitles' }),
        ctx.segField({ id: 'toolActivity', title: 'Tool activity', desc: 'How tool calls show in chat.', keywords: 'tools calls rows fold collapse group summary quiet verbose conversation', field: 'toolActivity', choices: TOOL_ACTIVITY }),
        ctx.textField({ id: 'maxTurns', inputId: 'maxTurns', title: 'Max tool turns', desc: 'Model calls before it stops to ask.', keywords: 'limit steps iterations request', field: 'maxTurns', type: 'number', width: 96, parse: (t) => parseInteger(t, 1, 500) }),
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
    ),
  );

  return {
    id: 'general',
    el,
    sync(cfg) {
      updatesSwitch.checked = updatesOn(cfg);
      pathDesc(folder, cfg.workingDirectory);
    },
    async load() {
      try {
        showPower(await ctx.call('power.status'));
      } catch {
        showPower(null);
      }
      try {
        const info = await ctx.call('app.info');
        updatesRow.setDesc(info.version ? `Version ${info.version}` : '');
      } catch {
        updatesRow.setDesc('');
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
  const modeOf = (v: unknown): PermissionMode => (order.includes(v as PermissionMode) ? (v as PermissionMode) : 'ask');
  // The mode is a segmented control; the row says what the chosen one does
  const mode = ctx.segField({
    id: 'permissionMode',
    title: 'Default mode',
    desc: MODES[modeOf(ctx.config().permissionMode)].desc + '.',
    keywords: `ask accept edits auto plan bypass approval approve the mode each session starts in ${order.map((m) => MODES[m].desc).join(' ')}`,
    field: 'permissionMode',
    choices: order.map((m) => ({ value: m, label: SHORT[m] })),
    read: modeOf,
    onSaved: (v) => mode.setDesc(MODES[v].desc + '.'),
  });
  mode.control.querySelector('[role=radiogroup]')!.id = 'permissionMode';

  // The shell sandbox: on, this Mac's own ports, more folders it may write; one plain line when this Mac cannot run it
  const SANDBOX_DESC = 'Contained commands skip the safety check.';
  const sandbox = ctx.switchField({ id: 'sandbox-enabled', title: 'Run commands in a sandbox', desc: SANDBOX_DESC, keywords: 'sandbox shell bash commands auto mode check contained seatbelt plan project temp folders without the check', field: 'sandbox.enabled' });
  const loopback = ctx.switchField({ id: 'sandbox-loopback', title: 'Local ports', desc: 'Reach servers on this Mac.', keywords: 'sandbox localhost loopback ports network servers tests databases docker ollama', field: 'sandbox.loopback' });
  const folders = ctx.textField({
    id: 'sandbox-allowWrite',
    inputId: 'sandbox-allowWrite',
    title: 'Extra writable folders',
    desc: 'One per line.',
    keywords: 'sandbox folders write allow paths extra commands may also write',
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
    mode.setDesc(MODES[modeOf(cfg.permissionMode)].desc + '.');
    if (on && probed === null) {
      probed = true;
      ctx
        .call('auto.sandbox')
        .then((r) => sandbox.setDesc(r.available ? SANDBOX_DESC : 'This Mac cannot run the sandbox.'))
        .catch(() => undefined);
    }
  };

  // The project's rules: the panel (its list and its add row), and the format as a link
  const rules = row({ id: 'rules', title: 'Rules', desc: 'What runs, asks or is refused in this project.', keywords: 'always allow ask deny rules project commands programs mcp edits bash read write pattern format reference', full: true, bare: true }, rulesEl);
  rulesEl.classList.add('sp-embedded');

  // Advanced: what Auto mode learned (only when it learned something) and what it blocked lately (only when it did)
  const learned = learnedAnswers(ctx, (n) => (learnedCard.hidden = n === 0));
  const blocked = recentlyBlocked(ctx, (n) => (blockedCard.hidden = n === 0));
  const learn = ctx.switchField({ id: 'autoMode-learn', title: 'Learn from my answers', desc: 'Auto mode decides like you did.', keywords: 'auto mode learn remember preferences answers approvals like cases', field: 'autoMode.learn' });
  const forget = row({ id: 'auto-learned', title: 'What it learned', keywords: 'auto mode learned answers forget all' }, learned.forgetAll);
  const learnedCard = card('What it learned', forget, learned.el);
  learnedCard.hidden = true;
  const blockedCard = card('Recently blocked', blocked.el);
  blockedCard.hidden = true;

  el.append(card(null, mode, sandbox, loopback, folders), card('Rules for this project', rules), advanced('permissions', card(null, learn), learnedCard, blockedCard));
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

/** The rows that were Settings → Context: under Models → Advanced now (their words still find them: "context"). */
export function contextRows(ctx: Ctx): Row[] {
  return [
    ctx.switchField({ id: 'autoCompact', title: 'Auto-compact', desc: 'Summarise when the context fills up.', keywords: 'context compaction summary summarise conversation', field: 'autoCompact' }),
    ctx.selectField({
      id: 'compactThreshold',
      inputId: 'compactThreshold',
      title: 'Compact at',
      desc: 'How full the context gets first.',
      keywords: 'context threshold percent compaction before summarising',
      field: 'compactThreshold',
      width: 120,
      choices: COMPACT_AT.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
      read: (v) => nearestCompactStep(v),
    }),
    ctx.switchField({ id: 'pruneToolResults', title: 'Trim old tool output', desc: 'Shorten old results before summarising.', keywords: 'context prune shorten compaction tool results', field: 'pruneToolResults' }),
    ctx.segField({
      id: 'toolSet',
      title: 'Tools offered',
      desc: 'Essential suits small context windows.',
      keywords: 'context tools offered to the model schedule sub-session subagent mods small window local model overhead essential all automatic browser',
      field: 'toolSet',
      choices: TOOL_SET,
    }),
    ctx.switchField({ id: 'sendScreenshotsToModel', title: 'Send browser screenshots', desc: 'Needs a model with vision.', keywords: 'context vision images browser screenshots to the model', field: 'sendScreenshotsToModel' }),
  ];
}
