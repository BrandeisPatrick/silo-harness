// General, Model, Permissions and Context: the sections that are rows over the config.

import type { AppConfig, PermissionMode, ProviderView } from '../../shared/types';
import type { CliStatus } from '../../shared/providers';
import type { PowerStatus } from '../../shared/schedules';
import { escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';
import { MODES } from '../modes.js';
import { onPush } from '../rpc.js';
import { COMPACT_AT, KEEP_AWAKE, nearestCompactStep, parseInteger, parseText, parseUrl, TOOL_ACTIVITY, TOOL_SET } from './model.js';
import { actions, button, group, iconButton, row, sectionTitle, textControl, tildePath, type Choice } from './ui.js';
import { activeProvider, allProviders } from '../provider-view.js';
import type { Ctx, Section } from './ctx.js';
import { recentlyBlocked } from '../auto-blocked.js';

export function generalSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('General'));

  const folder = row({ id: 'workingDirectory', title: 'Working folder', desc: '', keywords: 'directory project cwd path folder', field: 'workingDirectory' }, button('Change…', () => void ctx.chooseFolder(), { icon: 'folder' }));
  folder.descEl.classList.add('sp-path');

  const awake = ctx.segField({
    id: 'keepAwake',
    title: 'Keep awake',
    desc: 'Stop this Mac from sleeping while the agent works, or whenever Silo Harness is open.',
    keywords: 'sleep caffeinate power battery lid',
    field: 'keepAwake',
    choices: KEEP_AWAKE,
  });
  const awakeBase = 'Stop this Mac from sleeping while the agent works, or whenever Silo Harness is open.';
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
      ? ' (not in this copy of the app)'
      : st.conflict
        ? `. ${st.conflict}`
        : st.installed && !st.onPath
          ? `. Linked in ${tildePath(st.link.replace(/\/silo$/, ''))}, which is not on your PATH: add it to your shell profile, or run the command by its full path.`
          : st.installed
            ? `. Linked as ${tildePath(st.link)}.`
            : `. Install puts a link in ${tildePath(st.link.replace(/\/silo$/, ''))} (no administrator password).`;
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

  el.append(
    group(
      null,
      folder,
      awake,
      ctx.segField({
        id: 'toolActivity',
        title: 'Tool activity',
        desc: 'Fold each run of tool calls into one line that says what it did, or show every call as its own row.',
        keywords: 'tools calls rows fold collapse group summary quiet verbose',
        field: 'toolActivity',
        choices: TOOL_ACTIVITY,
      }),
      cli,
      ctx.switchField({ id: 'notifications', title: 'Notifications', desc: 'Notify when a run finishes or needs your approval while Silo Harness is in the background.', keywords: 'alert notify banner sound', field: 'notifications' }),
      ctx.switchField({ id: 'autoTitles', title: 'Generated titles', desc: 'Name a session from its first exchange.', keywords: 'session name rename title', field: 'autoTitles' }),
      ctx.textField({ id: 'maxTurns', inputId: 'maxTurns', title: 'Max tool turns', desc: 'How many tool calls one request may make before it stops and asks you to continue.', keywords: 'limit steps iterations', field: 'maxTurns', type: 'number', width: 96, parse: (t) => parseInteger(t, 1, 500) }),
      ctx.textField({
        id: 'systemPromptExtra',
        inputId: 'systemPromptExtra',
        title: 'Extra system prompt',
        desc: 'Added to every request: house rules, coding style, project context. Saved when you leave the field or press ⌘↵.',
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

export function modelSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Model'));
  /** 'ollama', 'portkey', or 'named' for every named provider (they share one set of rows) */
  type Kind = 'ollama' | 'portkey' | 'named';
  const providerRows: { el: HTMLElement; provider: Kind }[] = [];
  const tag = <T extends { el: HTMLElement }>(r: T, provider: Kind): T => {
    r.el.dataset.provider = provider;
    providerRows.push({ el: r.el, provider });
    return r;
  };
  const kindOf = (p: string): Kind => (p === 'ollama' || p === 'portkey' ? p : 'named');
  const syncProvider = (p: AppConfig['provider']) => {
    const k = kindOf(p);
    for (const r of providerRows) r.el.classList.toggle('provider-off', r.provider !== k);
    advanced.classList.toggle('provider-off', k !== 'portkey');
  };

  // The choices are every provider the config has; sync() rebuilds them (the selectField keeps this array).
  const providerChoices: Choice<string>[] = [];
  const choicesFor = (cfg: AppConfig): Choice<string>[] =>
    allProviders(cfg).map((p) => ({ value: p.name, label: p.name === 'ollama' ? 'Ollama' : p.name === 'portkey' ? `${p.label} (built-in gateway)` : p.label.toLowerCase() === p.name.toLowerCase() || p.label.endsWith(`(${p.name})`) ? p.label : `${p.label} (${p.name})` }));
  const setChoices = (cfg: AppConfig) => {
    const next = choicesFor(cfg);
    // An unknown name stays visible as it is, so the select does not pretend another provider is in use
    if (!next.some((c) => c.value === cfg.provider)) next.push({ value: cfg.provider, label: `${cfg.provider} (not defined)` });
    providerChoices.splice(0, providerChoices.length, ...next);
    const select = provider.control.querySelector('select');
    if (!select) return;
    const want = next.map((c) => `${c.value}\u0000${c.label}`).join('\u0001');
    if (select.dataset.choices !== want) {
      select.replaceChildren(...next.map((c) => h('option', { value: c.value }, c.label)));
      select.dataset.choices = want;
    }
    select.value = cfg.provider;
  };

  const provider = ctx.selectField({
    id: 'provider',
    inputId: 'provider',
    title: 'Provider',
    desc: 'Where Silo Harness sends model requests: Ollama on this Mac, a gateway such as Portkey, or any provider named in settings.json (OpenRouter, OpenAI, Anthropic, LM Studio, …).',
    keywords: 'ollama portkey gateway local cloud openrouter openai anthropic groq deepseek together lm studio service',
    field: 'provider',
    width: 300,
    choices: providerChoices,
    onSaved: (v) => {
      syncProvider(v);
      ctx.refreshSearch();
    },
  });
  setChoices(ctx.config());

  // Named providers: what the entry resolves to, its model, and a test
  const named = (): ProviderView => activeProvider(ctx.config());
  const service = tag(row({ id: 'provider-service', title: 'Service', desc: '', keywords: 'base url endpoint type test check' }, null), 'named');
  service.descEl.classList.add('sp-path');
  const testBtn = button('Test', () => void runTest(), { icon: 'play' });
  service.control.append(testBtn);
  async function runTest(): Promise<void> {
    testBtn.disabled = true;
    service.problem(null);
    try {
      const r = await ctx.call('providers.test', named().name);
      if (r.ok) {
        service.setDesc(`${serviceText(named())} · answered with ${r.model} in ${r.ms} ms`);
        service.saved();
      } else service.problem(r.error ?? 'It did not answer.');
    } catch (err) {
      service.problem(ctx.cleanError(err));
    } finally {
      testBtn.disabled = false;
    }
  }
  const serviceText = (p: ProviderView) => `${p.label} · ${p.type} · ${p.baseURL || 'no base URL'}`;
  const keyRow = tag(row({ id: 'provider-key', title: 'API key', desc: '', keywords: 'token secret credential environment variable' }, null), 'named');

  const namedModels = h('datalist', { id: 'provider-models' });
  const namedModel = textControl({
    value: '',
    placeholder: 'Model id',
    width: 260,
    mono: true,
    id: 'provider-model',
    onCommit: async (text) => {
      const m = text.trim();
      const p = named();
      if (!m || m === p.model) {
        namedModel.set(p.model);
        return;
      }
      try {
        await ctx.call('providers.setModel', p.name, m);
        modelRow.problem(null);
        modelRow.saved();
      } catch (err) {
        modelRow.problem(ctx.cleanError(err));
        namedModel.set(p.model);
      }
    },
  });
  namedModel.input.setAttribute('list', 'provider-models');
  const namedRefresh = iconButton('refresh', 'Ask the service for its models', () => void refreshNamedModels());
  const modelRow = tag(row({ id: 'provider-model', title: 'Model', desc: '', keywords: 'llm model id' }, namedModel), 'named');
  modelRow.control.append(namedModels, namedRefresh);
  async function refreshNamedModels(): Promise<void> {
    const p = named();
    if (p.builtIn) return;
    namedRefresh.classList.add('spinning');
    try {
      const models = await ctx.call('providers.models', p.name);
      if (named().name !== p.name) return;
      namedModels.replaceChildren(...models.map((m) => h('option', { value: m })));
      modelRow.setDesc(models.length ? `${models.length} model${models.length === 1 ? '' : 's'} offered${p.models.length ? ' (the entry\'s list first)' : ''}.` : 'The service listed no models; type the model id.');
    } catch (err) {
      if (named().name !== p.name) return;
      namedModels.replaceChildren(...p.models.map((m) => h('option', { value: m })));
      modelRow.setDesc(`Type the model id; the service could not be asked for its list (${ctx.cleanError(err)}).`);
    } finally {
      namedRefresh.classList.remove('spinning');
    }
  }
  const windowRow = tag(row({ id: 'provider-contextWindow', title: 'Context window', desc: '', keywords: 'tokens size memory' }, null), 'named');

  const files = row(
    { id: 'provider-files', title: 'More providers', desc: 'Add OpenRouter, OpenAI, Anthropic, Groq, DeepSeek, Together, LM Studio or any OpenAI-compatible service in settings.json, or from the command line: silo provider add <name> --type <type>. A coding agent can do it for you; see docs/configure.md.', keywords: 'add provider new openrouter openai anthropic groq deepseek together lmstudio cli command settings.json configure' },
    button('Open settings.json', () => void ctx.call('settings.open', 'user').catch((err) => files.problem(ctx.cleanError(err))), { icon: 'file' }),
  );

  let lastNamed = '';
  const syncNamed = (cfg: AppConfig) => {
    const p = activeProvider(cfg);
    if (p.builtIn) return;
    service.setDesc(serviceText(p));
    service.problem(p.error && p.key !== 'missing' ? p.error : null);
    keyRow.setDesc(p.key === 'none' ? 'Not needed for this service.' : p.key === 'set' ? `Set (${p.keySource}). Keys are never shown here.` : `Not set. ${p.error ?? ''}`);
    keyRow.el.classList.toggle('invalid', p.key === 'missing');
    if (document.activeElement !== namedModel.input) namedModel.set(p.model);
    const owner = p.owner;
    modelRow.setDesc(owner ? `Defined in ${owner === 'project' ? "the project's" : 'your'} settings.json; a model chosen here lasts until the file is read again.` : 'The model to run, as the service names it.');
    windowRow.setDesc(`${p.contextWindow.toLocaleString('en-US')} tokens${p.maxOutput ? `, replies up to ${p.maxOutput.toLocaleString('en-US')}` : ''}. Set contextWindow in the entry when the model's is different.`);
    if (p.name !== lastNamed) {
      lastNamed = p.name;
      namedModels.replaceChildren(...p.models.map((m) => h('option', { value: m })));
      void refreshNamedModels();
    }
  };

  // Ollama
  const modelList = h('datalist', { id: 'ollama-models' });
  const ollamaModel = tag(
    ctx.textField({ id: 'ollama-model', inputId: 'ollama-model', title: 'Model', desc: 'A model that supports tool calling, such as qwen3:8b.', keywords: 'tag llm', pill: 'Ollama', field: 'ollama.model', placeholder: 'qwen3:8b', parse: parseText }),
    'ollama',
  );
  const modelInput = ollamaModel.control.querySelector('input')!;
  modelInput.setAttribute('list', 'ollama-models');
  const refreshBtn = iconButton('refresh', 'Refresh the local models', () => void refreshModels());
  ollamaModel.control.append(modelList, refreshBtn);

  async function refreshModels(): Promise<void> {
    if (ctx.config().provider !== 'ollama') return;
    refreshBtn.classList.add('spinning');
    try {
      const models = await window.oc.listOllamaModels();
      modelList.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      ollamaModel.setDesc(models.length ? `${models.length} local model${models.length === 1 ? '' : 's'}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ', …' : ''}` : 'Ollama is running but has no models. Try: ollama pull qwen3:8b');
    } catch (err) {
      ollamaModel.setDesc(`Could not reach Ollama (${ctx.cleanError(err)}). Start it with: ollama serve`);
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  }

  const ollama = group(
    null,
    tag(ctx.textField({ id: 'ollama-baseURL', inputId: 'ollama-baseURL', title: 'Base URL', desc: 'The OpenAI-compatible endpoint of your Ollama server.', keywords: 'endpoint address server host', pill: 'Ollama', field: 'ollama.baseURL', placeholder: 'http://localhost:11434/v1', mono: true, width: 260, parse: parseUrl }), 'ollama'),
    ollamaModel,
    tag(
      ctx.textField({
        id: 'ollama-numCtx',
        inputId: 'ollama-numCtx',
        title: 'Context size',
        desc: "Tokens of context Ollama is asked for. Its own default, 4096, is too small for agent work.",
        keywords: 'num_ctx tokens window memory',
        pill: 'Ollama',
        field: 'ollama.numCtx',
        type: 'number',
        width: 120,
        format: (v) => String(v ?? ''),
        parse: (t) => parseInteger(t, 2048, 1_048_576),
      }),
      'ollama',
    ),
    tag(
      ctx.selectField({
        id: 'ollama-think',
        inputId: 'ollama-think',
        title: 'Thinking',
        desc: 'For models that can reason before they answer (qwen3, deepseek-r1, gpt-oss).',
        keywords: 'reasoning think',
        pill: 'Ollama',
        field: 'ollama.think',
        width: 160,
        choices: [
          { value: 'auto', label: 'Model default' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      }),
      'ollama',
    ),
  );

  // Gateway
  const pk = (o: Parameters<Ctx['textField']>[0]) => tag(ctx.textField({ pill: 'Gateway', mono: true, width: 260, ...o }), 'portkey');
  const gateway = group(
    null,
    pk({ id: 'portkey-baseURL', inputId: 'portkey-baseURL', title: 'Base URL', desc: 'The gateway endpoint: Portkey, or a gateway you host.', keywords: 'endpoint address server host', field: 'portkey.baseURL', placeholder: 'https://api.portkey.ai/v1', parse: parseUrl }),
    pk({ id: 'portkey-apiKey', inputId: 'portkey-apiKey', title: 'API key', desc: 'Your gateway key. Without one, Silo Harness uses PORTKEY_API_KEY from the environment.', keywords: 'token secret password credential', field: 'portkey.apiKey', type: 'password', placeholder: 'pk-…', parse: parseText }),
    pk({ id: 'portkey-model', inputId: 'portkey-model', title: 'Model', desc: 'A model-catalog id like @openai/gpt-4o-mini, or a plain id with a virtual key or provider below.', keywords: 'llm', field: 'portkey.model', placeholder: '@openai/gpt-4o-mini', parse: parseText }),
    pk({
      id: 'portkey-contextWindow',
      inputId: 'portkey-contextWindow',
      title: 'Context window',
      desc: "The model's window in tokens. The gateway does not report it; the context meter and auto-compaction go by it.",
      keywords: 'tokens size memory',
      field: 'portkey.contextWindow',
      type: 'number',
      mono: false,
      width: 120,
      parse: (t) => parseInteger(t, 1024, 10_000_000),
    }),
  );

  const advancedToggle = h('button', { type: 'button', class: 'sp-disclosure', 'aria-expanded': 'false' });
  advancedToggle.innerHTML = `${icon('chevron-right', 14)}<span>Advanced routing</span>`;
  const advancedRows = h(
    'div',
    { class: 'sp-advanced-rows' },
    pk({ id: 'portkey-virtualKey', inputId: 'portkey-virtualKey', title: 'Virtual key', desc: 'Sent as x-portkey-virtual-key.', keywords: 'advanced routing', field: 'portkey.virtualKey', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-provider', inputId: 'portkey-provider', title: 'Provider slug', desc: 'Sent as x-portkey-provider, e.g. openai, anthropic, groq.', keywords: 'advanced routing', field: 'portkey.provider', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-providerApiKey', inputId: 'portkey-providerApiKey', title: 'Provider API key', desc: "That provider's own key, sent as Authorization: Bearer.", keywords: 'advanced routing token secret', field: 'portkey.providerApiKey', type: 'password', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-configId', inputId: 'portkey-configId', title: 'Config ID', desc: 'A Portkey config for routing, fallbacks and caching (x-portkey-config).', keywords: 'advanced routing fallback cache', field: 'portkey.configId', placeholder: 'pc-…', parse: parseText }).el,
  );
  const advanced = h('div', { class: 'sp-advanced' }, h('div', { class: 'sp-disclosure-row' }, advancedToggle), advancedRows);
  advancedToggle.addEventListener('click', () => {
    const open = !advanced.classList.contains('open');
    advanced.classList.toggle('open', open);
    advancedToggle.setAttribute('aria-expanded', String(open));
  });
  gateway.append(advanced);

  const namedGroup = group(null, service, keyRow, modelRow, windowRow);
  el.append(group(null, provider), ollama, gateway, namedGroup, group(null, files));

  let lastProvider = '';
  return {
    id: 'model',
    el,
    sync(cfg) {
      setChoices(cfg);
      syncProvider(cfg.provider);
      syncNamed(cfg);
      if (cfg.provider === 'ollama' && lastProvider !== 'ollama') void refreshModels();
      lastProvider = cfg.provider;
    },
    async load() {
      const cfg = ctx.config();
      lastProvider = cfg.provider;
      setChoices(cfg);
      syncProvider(cfg.provider);
      lastNamed = '';
      syncNamed(cfg);
      void refreshModels();
      return 'ok';
    },
  };
}

export function permissionsSection(ctx: Ctx, rulesEl: HTMLElement): Section {
  const el = h('section', {}, sectionTitle('Permissions'));
  const order: PermissionMode[] = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];
  const SHORT: Record<PermissionMode, string> = { ask: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypass: 'Bypass' };
  const mode = ctx.selectField({
    id: 'permissionMode',
    inputId: 'permissionMode',
    title: 'Default mode',
    desc: '',
    keywords: 'ask accept edits auto plan bypass approval approve',
    field: 'permissionMode',
    width: 340,
    choices: order.map((m) => ({ value: m, label: `${SHORT[m]} · ${MODES[m].desc}` })),
    read: (v) => (order.includes(v as PermissionMode) ? (v as PermissionMode) : 'ask'),
  });
  const rules = row({ id: 'rules', title: 'Saved rules', desc: 'Answers you gave with "Always allow … in this project". Matching actions run without an approval card.', keywords: 'always allow rules project commands programs mcp edits', full: true }, rulesEl);
  rulesEl.classList.add('sp-embedded');
  const blocked = recentlyBlocked(ctx);
  el.append(group(null, mode), group('This project', rules), group('Recently blocked', blocked.el));
  return {
    id: 'permissions',
    el,
    sync(cfg) {
      const m = order.includes(cfg.permissionMode) ? cfg.permissionMode : 'ask';
      mode.setDesc(`${MODES[m].hint}. The mode chip in the composer changes it for now; this is where it starts.`);
    },
    async load() {
      await blocked.refresh();
      return 'ok';
    },
  };
}

export function contextSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Context'));
  el.append(
    group(
      null,
      ctx.switchField({ id: 'autoCompact', title: 'Auto-compact', desc: 'Summarise the conversation on its own when it nears the context window.', keywords: 'compaction summary summarise', field: 'autoCompact' }),
      ctx.selectField({
        id: 'compactThreshold',
        inputId: 'compactThreshold',
        title: 'Compact at',
        desc: 'How full the context window gets before the conversation is summarised.',
        keywords: 'threshold percent compaction',
        field: 'compactThreshold',
        width: 120,
        choices: COMPACT_AT.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
        read: (v) => nearestCompactStep(v),
      }),
      ctx.segField({
        id: 'toolSet',
        title: 'Tools offered to the model',
        desc: 'Every tool is described to the model in every request. Essential keeps files, shell, browser, terminal, tasks, artifacts and images; All adds scheduled tasks, sub-sessions and mod authoring. Automatic offers all of them when the context window is at least 32k tokens.',
        keywords: 'tools schedule sub-session subagent mods small window local model overhead',
        field: 'toolSet',
        choices: TOOL_SET,
      }),
      ctx.switchField({ id: 'pruneToolResults', title: 'Trim old tool output', desc: 'Before summarising, shorten old tool results the model no longer needs word for word.', keywords: 'prune shorten compaction', field: 'pruneToolResults' }),
      ctx.switchField({ id: 'sendScreenshotsToModel', title: 'Send browser screenshots to the model', desc: 'Attach browser screenshots to the conversation as images. Needs a vision-capable model.', keywords: 'vision images browser', field: 'sendScreenshotsToModel' }),
    ),
  );
  return { id: 'context', el };
}
