// Settings → Models: the model in use and the safety check's, every connected provider with the models it offers
// (each with a live Test, on a click only, and Use), then the fields of the provider in use (its connection) and
// "More providers". The section's id stays 'model', so openSettings('model') and the old targets still land here.

import type { AppConfig, ProviderView } from '../../shared/types';
import type { ProviderCatalog } from '../../shared/providers';
import type { CheckModelInfo, CheckTestReport } from '../../shared/auto-mode';
import { escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';
import { parseInteger, parseText, parseUrl } from './model.js';
import { CHECK_EVAL_NOTE, checkChoices, checkModelWords, checkTestPlan, checkTestWords, modelIds, providerState, rowKey, shownModels, testWords, thinkingWords } from './models-model.js';
import { actions, button, chip, group, groupTitle, iconButton, note, row, sectionTitle, textControl, type Choice } from './ui.js';
import { onPush } from '../rpc.js';
import { activeProvider, allProviders } from '../provider-view.js';
import type { Ctx, Section } from './ctx.js';
import { LatestRequests } from './models-model.js';

/** A list the page fetched less than this long ago is shown again as it is (Refresh asks again) */
const CATALOG_FRESH_MS = 2 * 60_000;

export function modelSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Models'));
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
    desc: 'Where model requests go.',
    keywords: 'ollama portkey gateway local cloud openrouter openai anthropic groq deepseek together lm studio service connected models list test',
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
  const namedRefresh = iconButton('refresh', 'Refresh models', () => void refreshNamedModels(true));
  const modelRow = tag(row({ id: 'provider-model', title: 'Model', desc: '', keywords: 'llm model id' }, namedModel), 'named');
  modelRow.control.append(namedModels, namedRefresh);
  /** The named provider's models for the field's suggestions: the same list Connected shows (one request for both) */
  async function refreshNamedModels(force = false): Promise<void> {
    const p = named();
    if (p.builtIn) return;
    namedRefresh.classList.add('spinning');
    try {
      const cat = await catalog(p.name, force);
      if (named().name !== p.name) return;
      if (cat.listed) {
        namedModels.replaceChildren(...cat.models.map((m) => h('option', { value: m })));
        modelRow.setDesc(cat.models.length ? `${cat.models.length} model${cat.models.length === 1 ? '' : 's'} offered.` : 'The service listed no models. Type the model id.');
      } else {
        namedModels.replaceChildren(...p.models.map((m) => h('option', { value: m })));
        modelRow.setDesc(`Couldn't list the models: ${cat.error ?? 'no answer'}. Type the model id.`);
      }
    } finally {
      namedRefresh.classList.remove('spinning');
    }
  }
  const windowRow = tag(row({ id: 'provider-contextWindow', title: 'Context window', desc: '', keywords: 'tokens size memory' }, null), 'named');

  const files = row(
    { id: 'provider-files', title: 'More providers', desc: 'Add OpenAI-compatible services in settings.json.', keywords: 'add provider new openrouter openai anthropic groq deepseek together lmstudio cli command settings.json configure' },
    button('Open settings.json', () => void ctx.call('settings.open', 'user').catch((err) => files.problem(ctx.cleanError(err))), { icon: 'file' }),
  );

  let lastNamed = '';
  const syncNamed = (cfg: AppConfig) => {
    const p = activeProvider(cfg);
    if (p.builtIn) return;
    service.setDesc(serviceText(p));
    service.problem(p.error && p.key !== 'missing' ? p.error : null);
    keyRow.setDesc(p.key === 'none' ? 'Not needed for this service.' : p.key === 'set' ? `Set from ${p.keySource}.` : `Not set. ${p.error ?? ''}`);
    keyRow.el.classList.toggle('invalid', p.key === 'missing');
    if (document.activeElement !== namedModel.input) namedModel.set(p.model);
    const owner = p.owner;
    modelRow.setDesc(owner ? `Set in ${owner === 'project' ? "the project's" : 'your'} settings.json. A choice here lasts until the file reloads.` : '');
    windowRow.setDesc(`${p.contextWindow.toLocaleString('en-US')} tokens${p.maxOutput ? `, replies up to ${p.maxOutput.toLocaleString('en-US')}` : ''}.`);
    if (p.name !== lastNamed) {
      lastNamed = p.name;
      namedModels.replaceChildren(...p.models.map((m) => h('option', { value: m })));
      void refreshNamedModels();
    }
  };

  // Ollama
  const modelList = h('datalist', { id: 'ollama-models' });
  const ollamaModel = tag(
    ctx.textField({ id: 'ollama-model', inputId: 'ollama-model', title: 'Model', desc: 'A model with tool calling.', keywords: 'tag llm', pill: 'Ollama', field: 'ollama.model', placeholder: 'qwen3:8b', parse: parseText }),
    'ollama',
  );
  const modelInput = ollamaModel.control.querySelector('input')!;
  modelInput.setAttribute('list', 'ollama-models');
  const refreshBtn = iconButton('refresh', 'Refresh models', () => void refreshModels());
  ollamaModel.control.append(modelList, refreshBtn);

  async function refreshModels(): Promise<void> {
    if (ctx.config().provider !== 'ollama') return;
    refreshBtn.classList.add('spinning');
    try {
      const models = await window.oc.listOllamaModels();
      modelList.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      ollamaModel.setDesc(models.length ? `${models.length} local model${models.length === 1 ? '' : 's'}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ', …' : ''}` : 'Ollama has no models. Run ollama pull qwen3:8b.');
    } catch (err) {
      ollamaModel.setDesc(`Couldn't reach Ollama: ${ctx.cleanError(err)}. Run ollama serve.`);
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  }

  const ollamaRows = [
    tag(ctx.textField({ id: 'ollama-baseURL', inputId: 'ollama-baseURL', title: 'Base URL', keywords: 'endpoint address server host', pill: 'Ollama', field: 'ollama.baseURL', placeholder: 'http://localhost:11434/v1', mono: true, width: 260, parse: parseUrl }), 'ollama'),
    tag(
      ctx.textField({
        id: 'ollama-numCtx',
        inputId: 'ollama-numCtx',
        title: 'Context size',
        desc: 'Tokens of context to ask Ollama for.',
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
        desc: 'For models that reason before answering.',
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
  ];

  // Gateway
  const pk = (o: Parameters<Ctx['textField']>[0]) => tag(ctx.textField({ pill: 'Gateway', mono: true, width: 260, ...o }), 'portkey');
  const gatewayModel = pk({ id: 'portkey-model', inputId: 'portkey-model', title: 'Model', desc: 'A catalog id, or a plain id with routing below.', keywords: 'llm', field: 'portkey.model', placeholder: '@openai/gpt-4o-mini', parse: parseText });
  const gatewayRows = [
    pk({ id: 'portkey-baseURL', inputId: 'portkey-baseURL', title: 'Base URL', keywords: 'endpoint address server host gateway portkey', field: 'portkey.baseURL', placeholder: 'https://api.portkey.ai/v1', parse: parseUrl }),
    pk({ id: 'portkey-apiKey', inputId: 'portkey-apiKey', title: 'API key', desc: 'Empty uses PORTKEY_API_KEY from the environment.', keywords: 'token secret password credential', field: 'portkey.apiKey', type: 'password', placeholder: 'pk-…', parse: parseText }),
    pk({
      id: 'portkey-contextWindow',
      inputId: 'portkey-contextWindow',
      title: 'Context window',
      desc: "The model's window, in tokens.",
      keywords: 'tokens size memory',
      field: 'portkey.contextWindow',
      type: 'number',
      mono: false,
      width: 120,
      parse: (t) => parseInteger(t, 1024, 10_000_000),
    }),
  ];

  const advancedToggle = h('button', { type: 'button', class: 'sp-disclosure', 'aria-expanded': 'false' });
  advancedToggle.innerHTML = `${icon('chevron-right', 14)}<span>Advanced routing</span>`;
  const advancedRows = h(
    'div',
    { class: 'sp-advanced-rows' },
    pk({ id: 'portkey-virtualKey', inputId: 'portkey-virtualKey', title: 'Virtual key', desc: 'Sent as x-portkey-virtual-key.', keywords: 'advanced routing', field: 'portkey.virtualKey', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-provider', inputId: 'portkey-provider', title: 'Provider slug', desc: 'Sent as x-portkey-provider.', keywords: 'advanced routing', field: 'portkey.provider', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-providerApiKey', inputId: 'portkey-providerApiKey', title: 'Provider API key', desc: "That provider's own key, sent as Authorization: Bearer.", keywords: 'advanced routing token secret', field: 'portkey.providerApiKey', type: 'password', placeholder: 'Optional', parse: parseText }).el,
    pk({ id: 'portkey-configId', inputId: 'portkey-configId', title: 'Config ID', desc: 'A Portkey config, sent as x-portkey-config.', keywords: 'advanced routing fallback cache', field: 'portkey.configId', placeholder: 'pc-…', parse: parseText }).el,
  );
  const advanced = h('div', { class: 'sp-advanced' }, h('div', { class: 'sp-disclosure-row' }, advancedToggle), advancedRows);
  advancedToggle.addEventListener('click', () => {
    const open = !advanced.classList.contains('open');
    advanced.classList.toggle('open', open);
    advancedToggle.setAttribute('aria-expanded', String(open));
  });

  // ---------- Connected: every provider and the models it offers ----------

  /** Each provider's list, with when it came and what it was asked as (a new key or address asks again) */
  const catalogs = new Map<string, { at: number; sig: string; cat: ProviderCatalog }>();
  /** The latest list request per provider: an older one's result is dropped, and the spinner follows the latest */
  const pending = new LatestRequests<ProviderCatalog>();
  /** Row test results, by provider and model, kept while the window is open */
  const results = new Map<string, { ok: boolean; text: string }>();
  /** Per group: the filter text and whether every model shows */
  const views = new Map<string, { query: string; all: boolean }>();
  const testing = new Set<string>();
  const sigOf = (p: ProviderView) => [p.type, p.baseURL, p.key, p.models.join(','), p.headers.join(',')].join('\u0001');
  const viewOf = (name: string) => allProviders(ctx.config()).find((p) => p.name === name);

  /** A provider's list: fresh from the page when asked lately as it is now, else from the main process. */
  async function catalog(name: string, force = false): Promise<ProviderCatalog> {
    const p = viewOf(name);
    const sig = p ? sigOf(p) : '';
    const have = catalogs.get(name);
    const inFlight = pending.inFlight(name);
    // A request out for another key or address would land after this answer and replace it: a new one is asked instead
    if (!force && have && have.sig === sig && Date.now() - have.at < CATALOG_FRESH_MS && (!inFlight || inFlight.sig === sig)) return have.cat;
    if (inFlight && !force && inFlight.sig === sig) return inFlight.req;
    const ask = () =>
      ctx
        .call('providers.catalog', name)
        .catch((err): ProviderCatalog => ({ name, models: p ? [p.model, ...p.models].filter(Boolean) : [], own: p ? [p.model, ...p.models].filter(Boolean) : [], listed: false, error: ctx.cleanError(err) }));
    const req = pending.start(name, sig, ask, (cat) => {
      catalogs.set(name, { at: Date.now(), sig, cat });
      renderGroup(name);
      setCheckChoices();
    });
    renderGroup(name);
    return req;
  }

  const connectedHead = [groupTitle('Connected'), note('The models each provider offers. Test sends one short request to that model; Use makes it the model your sessions run on.', 'sp-models-intro')];
  const connected = h('div', { class: 'sp-group sp-models sp-only-browse' }, ...connectedHead);
  const groupEls = new Map<string, HTMLElement>();

  /** The providers in the order the page lists them: the one in use first, then as the config has them. */
  const ordered = (cfg: AppConfig): ProviderView[] => {
    const all = allProviders(cfg);
    const name = cfg.provider || 'ollama';
    return [...all.filter((p) => p.name === name), ...all.filter((p) => p.name !== name)];
  };

  function renderAll(): void {
    const cfg = ctx.config();
    const list = ordered(cfg);
    const els: HTMLElement[] = [];
    for (const p of list) {
      let g = groupEls.get(p.name);
      if (!g) {
        g = h('div', { class: 'sp-provider', 'data-provider-name': p.name });
        groupEls.set(p.name, g);
      }
      els.push(g);
    }
    for (const [name, g] of groupEls) if (!list.some((p) => p.name === name)) {
      g.remove();
      groupEls.delete(name);
    }
    connected.replaceChildren(...connectedHead, ...els);
    for (const p of list) renderGroup(p.name);
  }

  function renderGroup(name: string): void {
    const g = groupEls.get(name);
    const cfg = ctx.config();
    const p = allProviders(cfg).find((x) => x.name === name);
    if (!g || !p) return;
    const inUse = p.name === (cfg.provider || 'ollama');
    const cat = catalogs.get(name)?.cat;
    const busy = pending.has(name);
    const state = busy && !cat ? { tone: 'neutral' as const, label: 'Checking…', detail: '' } : providerState(p, cat, inUse);
    const sessionModel = inUse ? p.model : '';
    const checkModel = checkOn(p.name);
    const ids = modelIds(p, cat, [sessionModel, checkModel].filter(Boolean));
    const keep = new Set([sessionModel, checkModel].filter(Boolean));
    const view = views.get(name) ?? { query: '', all: false };
    views.set(name, view);
    const shown = shownModels(ids, view.query, view.all, keep);

    // The head: "Through Gateway", its state, a refresh
    const refresh = iconButton('refresh', `Refresh ${p.label}'s models`, () => void catalog(name, true));
    if (busy) refresh.classList.add('spinning');
    refresh.disabled = p.key === 'missing';
    const head = h('div', { class: 'sp-provider-head' }, h('h5', { class: 'sp-provider-title' }, `Through ${p.label}`), chip(state.label, state.tone), h('span', { class: 'sp-provider-gap' }), refresh);
    const detail = state.detail ? h('div', { class: `sp-provider-detail${state.tone === 'danger' ? ' danger' : ''}` }, state.detail) : null;

    // The filter, for a long list (focus and the caret survive a re-render)
    let filter: HTMLElement | null = null;
    const hadFocus = document.activeElement instanceof HTMLInputElement && g.contains(document.activeElement) ? (document.activeElement as HTMLInputElement) : null;
    if (ids.length > 8) {
      const input = h('input', { type: 'search', class: 'sp-input sp-models-filter', placeholder: `Filter ${ids.length.toLocaleString('en-US')} models`, spellcheck: 'false', autocomplete: 'off', 'aria-label': `Filter ${p.label}'s models` });
      input.value = view.query;
      input.addEventListener('input', () => {
        view.query = input.value;
        renderGroup(name);
      });
      filter = h('div', { class: 'sp-models-filter-row' }, h('span', { class: 'sp-models-filter-icon', html: icon('search', 14) }), input);
    }

    const rows = shown.shown.map((m) => modelLine(p, m, inUse && m === p.model));
    // With nothing to list, the line under the head already says why (no key, not reachable, can't list)
    const empty = !ids.length ? (busy ? h('div', { class: 'sp-model-empty' }, 'Asking for the list…') : state.detail ? null : h('div', { class: 'sp-model-empty' }, 'No models to show.')) : view.query && !shown.matched ? h('div', { class: 'sp-model-empty' }, `No model matches “${view.query.trim()}”.`) : null;
    let more: HTMLElement | null = null;
    if (shown.more > 0 || (view.all && ids.length > 8 && !view.query)) {
      const label = view.all ? 'Show fewer' : `Show all ${shown.matched.toLocaleString('en-US')}`;
      more = h('button', { type: 'button', class: 'sp-models-more' }, label);
      more.addEventListener('click', () => {
        view.all = !view.all;
        renderGroup(name);
      });
    }
    g.replaceChildren(head, ...(detail ? [detail] : []), ...(filter ? [filter] : []), h('div', { class: 'sp-model-list' }, ...rows, ...(empty ? [empty] : [])), ...(more ? [more] : []));
    if (hadFocus && filter) {
      const input = filter.querySelector('input')!;
      const at = hadFocus.selectionStart ?? input.value.length;
      input.focus({ preventScroll: true });
      input.setSelectionRange(at, at);
    }
  }

  /** One model: its id, the marks, its last test's result, Use and Test. */
  function modelLine(p: ProviderView, m: string, isSession: boolean): HTMLElement {
    const key = rowKey(p.name, m);
    const res = results.get(key);
    const marks: HTMLElement[] = [];
    if (isSession) marks.push(chip('In use', 'ok'));
    if (checkOn(p.name) === m) marks.push(chip('Safety check'));
    const idEl = h('span', { class: 'sp-model-id', title: m }, m);
    const result = res ? h('div', { class: `sp-model-result${res.ok ? ' ok' : ' error'}`, role: 'status', html: `${icon(res.ok ? 'check' : 'circle-alert', 12)}<span>${escapeHtml(res.text)}</span>` }) : null;
    const text = h('div', { class: 'sp-model-text' }, h('div', { class: 'sp-model-line' }, idEl, ...marks), ...(result ? [result] : []));
    const test = button(testing.has(key) ? 'Testing…' : 'Test', () => void testModel(p.name, m), { icon: 'play', aria: `Test ${m}` });
    test.disabled = testing.has(key) || p.key === 'missing';
    if (p.key === 'missing') test.title = 'This provider has no key.';
    const actions = h('div', { class: 'sp-model-actions' });
    if (!isSession) {
      const use = button('Use', () => void useModel(p, m, use), { aria: `Use ${m}` });
      const locked = p.name !== (ctx.config().provider || 'ollama') && ctx.isOwned('provider');
      use.disabled = p.key === 'missing' || locked;
      if (locked) use.title = 'settings.json sets the provider.';
      actions.append(use);
    }
    actions.append(test);
    return h('div', { class: `sp-model${isSession ? ' current' : ''}`, 'data-model': m, 'data-provider': p.name }, text, actions);
  }

  /** One small live request to exactly this model through this provider: only ever on a click. */
  async function testModel(name: string, m: string): Promise<void> {
    const key = rowKey(name, m);
    if (testing.has(key)) return;
    testing.add(key);
    results.delete(key);
    renderGroup(name);
    try {
      const r = await ctx.call('providers.test', name, m);
      results.set(key, testWords(r));
    } catch (err) {
      results.set(key, { ok: false, text: ctx.cleanError(err) });
    } finally {
      testing.delete(key);
      renderGroup(name);
    }
  }

  /** Makes a model the one sessions use: its provider's model, and that provider in use. */
  async function useModel(p: ProviderView, m: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    const key = rowKey(p.name, m);
    try {
      await ctx.call('providers.setModel', p.name, m);
      if (p.name !== (ctx.config().provider || 'ollama') && !(await ctx.savePatch(provider, { provider: p.name }))) throw new Error('The provider could not be changed.');
      results.delete(key);
    } catch (err) {
      results.set(key, { ok: false, text: ctx.cleanError(err) });
      renderGroup(p.name);
    }
  }

  // ---------- Thinking before acting (AppConfig.thinking; Anthropic's own API only) ----------

  const thinkRow = ctx.switchField({
    id: 'thinking',
    title: 'Think before acting',
    desc: '',
    keywords: 'thinking reasoning reason adaptive claude code extended faster cheaper cost effort',
    field: 'thinking',
    values: { on: 'auto', off: 'off' },
  });
  const syncThinking = (cfg: AppConfig) => thinkRow.setDesc(thinkingWords(activeProvider(cfg)));

  // ---------- The safety check's model, and a test of it ----------

  /** What the check runs on now (auto.checkModel), null until asked or when this build has no check */
  let checkInfo: CheckModelInfo | null = null;
  /** The model of `provider` the check runs on now, '' when it is not one of that provider's */
  const checkOn = (name: string): string => (checkInfo && !checkInfo.none && checkInfo.provider === name ? (checkInfo.model ?? '') : '');
  const checkList: Choice<string>[] = [];
  const checkRow = ctx.selectField({
    id: 'autoMode-model',
    inputId: 'autoMode-model',
    title: 'Safety check',
    desc: '',
    keywords: 'auto mode safety check classifier judge model haiku same as the session eval',
    field: 'autoMode.model',
    width: 300,
    choices: checkList,
    read: (v) => String(v ?? ''),
    onSaved: () => void refreshCheck(),
  });
  checkRow.descEl.after(h('div', { class: 'sp-row-desc sp-check-note' }, CHECK_EVAL_NOTE));
  /** The select's choices: "Same as the session", then each usable provider's models (as Connected lists them) */
  const setCheckChoices = () => {
    const cfg = ctx.config();
    const active = cfg.provider || 'ollama';
    const groups = ordered(cfg).map((p) => ({ name: p.name, label: p.label, usable: p.key !== 'missing', models: modelIds(p, catalogs.get(p.name)?.cat, [p.name === active ? p.model : '', checkOn(p.name)].filter(Boolean)) }));
    const current = String(cfg.autoMode?.model ?? '').trim();
    const next = checkChoices(groups, current);
    checkList.splice(0, checkList.length, ...next.map((c) => ({ value: c.value, label: c.label })));
    const select = checkRow.control.querySelector('select');
    if (!select) return;
    const want = JSON.stringify(next);
    if (select.dataset.choices !== want) {
      const nodes: HTMLElement[] = [];
      let og: HTMLElement | null = null;
      for (const c of next) {
        const opt = h('option', { value: c.value }, c.label);
        if (!c.group) {
          og = null;
          nodes.push(opt);
        } else {
          if (!og || og.getAttribute('label') !== c.group) nodes.push((og = h('optgroup', { label: c.group })));
          og.append(opt);
        }
      }
      select.replaceChildren(...nodes);
      select.dataset.choices = want;
    }
    select.value = current;
  };

  let testRunning = false;
  let mine = false;
  const runBtn = button('Run test', () => void runCheck(), { icon: 'play' });
  const cancelBtn = button('Cancel', () => void ctx.call('auto.checkTestCancel').catch(() => undefined));
  cancelBtn.hidden = true;
  const testRow = row({ id: 'autoMode-checkTest', title: 'Test as safety check', desc: '', keywords: 'auto mode safety check classifier eval test accuracy judge false allow block run' }, actions(cancelBtn, runBtn));
  testRow.el.classList.add('sp-row-top');
  const resultEl = h('div', { class: 'sp-check-result', role: 'status', hidden: true });
  testRow.descEl.parentElement!.append(resultEl);
  const setRunning = (on: boolean, done = 0, total = checkInfo?.testCount ?? 0) => {
    testRunning = on;
    runBtn.hidden = on;
    cancelBtn.hidden = !on;
    testRow.setDesc(on ? `Checking ${Math.min(done + 1, Math.max(total, 1))} of ${total}…` : checkTestPlan(checkInfo));
  };
  // Progress of a run (this page's, or one still going from before the page opened)
  onPush('auto:check-test', (p) => {
    if (p.running) setRunning(true, p.done, p.total);
    else if (!mine) setRunning(false);
  });
  /** Runs the test, only on this click: the plan says beforehand how many requests it sends */
  async function runCheck(): Promise<void> {
    if (testRunning) return;
    mine = true;
    testRow.problem(null);
    resultEl.hidden = true;
    setRunning(true, 0);
    try {
      showCheckResult(await ctx.call('auto.checkTest'));
    } catch (err) {
      testRow.problem(ctx.cleanError(err));
    } finally {
      mine = false;
      setRunning(false);
    }
  }
  function showCheckResult(r: CheckTestReport): void {
    const w = checkTestWords(r);
    const glyph = (t: string) => (t === 'ok' ? 'check' : t === 'danger' ? 'circle-alert' : t === 'warn' ? 'triangle-alert' : 'clock');
    resultEl.replaceChildren(
      h('div', { class: `sp-check-head ${w.tone}` }, w.headline),
      ...w.lines.map((l) => h('div', { class: `sp-check-line ${l.tone}`, html: `${icon(glyph(l.tone), 12)}<span>${escapeHtml(l.text)}</span>` })),
      h('div', { class: 'sp-check-on' }, `Tested on ${r.model}.`),
    );
    resultEl.hidden = false;
  }

  /** Asks what the check runs on now; its words, the marks and the plan follow. */
  async function refreshCheck(): Promise<void> {
    try {
      checkInfo = await ctx.call('auto.checkModel');
    } catch (err) {
      checkInfo = null;
      if (ctx.isUnknown(err)) {
        checkRow.el.hidden = true;
        testRow.el.hidden = true;
        return;
      }
    }
    checkRow.setDesc(checkModelWords(checkInfo));
    if (!testRunning) testRow.setDesc(checkTestPlan(checkInfo));
    runBtn.disabled = !checkInfo || checkInfo.none;
    setCheckChoices();
    for (const p of allProviders(ctx.config())) renderGroup(p.name);
  }

  el.append(
    group('In use', provider, ollamaModel, gatewayModel, modelRow, thinkRow, checkRow, testRow),
    connected,
    group('Connection', ...ollamaRows, ...gatewayRows, advanced, service, keyRow, windowRow),
    group(null, files),
  );

  let lastProvider = '';
  const loadAll = (force = false) => {
    for (const p of allProviders(ctx.config())) void catalog(p.name, force);
  };
  // The lists are asked for when this section comes on screen, not whenever Settings opens: a provider on the local
  // network is reached only once the user opened the page that lists it
  let listsWanted = false;
  const loadWhenShown = () => {
    if (!listsWanted || !el.classList.contains('current')) return;
    listsWanted = false;
    loadAll();
  };
  new MutationObserver(loadWhenShown).observe(el, { attributes: true, attributeFilter: ['class'] });
  return {
    id: 'model',
    el,
    sync(cfg) {
      setChoices(cfg);
      syncProvider(cfg.provider);
      syncNamed(cfg);
      syncThinking(cfg);
      if (cfg.provider === 'ollama' && lastProvider !== 'ollama') void refreshModels();
      lastProvider = cfg.provider;
      renderAll();
      setCheckChoices();
      void refreshCheck();
      // A provider whose key or address changed is asked again, also while a request made before the change is out
      for (const p of allProviders(cfg)) {
        if (pending.askAgain(p.name, sigOf(p), catalogs.get(p.name)?.sig)) void catalog(p.name);
      }
    },
    async load() {
      const cfg = ctx.config();
      lastProvider = cfg.provider;
      setChoices(cfg);
      syncProvider(cfg.provider);
      lastNamed = '';
      syncNamed(cfg);
      syncThinking(cfg);
      void refreshModels();
      renderAll();
      setCheckChoices();
      void refreshCheck();
      listsWanted = true;
      loadWhenShown();
      return 'ok';
    },
  };
}
