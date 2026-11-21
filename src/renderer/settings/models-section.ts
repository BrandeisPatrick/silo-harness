// Settings → Models: one card for the model sessions run on.
//
//   Provider   [ Gateway            ▾ ]   ● Ready
//   Model      [ claude-opus-5-5    ▾ ]   [Test]
//   API key    [ ••••••••3f2a         ]   [Replace]
//   ▸ Connection
//   + Add provider
//
// Advanced: Think before acting (where it applies), the safety check's model with its test, then the context rows.
// Lists of models are asked for when the page comes on screen; a model is tested only on a click. A key goes to the
// main process once, when saved, and never comes back whole (providerView: set or not, and its last four characters).
// The section's id stays 'model', so openSettings('model') and the old targets still land here.

import type { AppConfig, ProviderView } from '../../shared/types';
import type { ProviderCatalog, ProviderPresetInfo } from '../../shared/providers';
import type { CheckModelInfo } from '../../shared/auto-mode';
import { escapeHtml, h } from '../dom.js';
import { icon } from '../icons.js';
import { parseInteger, parseText, parseUrl } from './model.js';
import { addFormReady, checkChoices, checkDesc, checkLine, checkModelWords, checkTestPlan, checkTestWords, cutId, keyFromWords, keyShown, LatestRequests, modelIds, pickableProviders, pickerMatches, providerStatus, shortReason, suggestName, testWords, thinkingWords } from './models-model.js';
import { advanced as pageAdvanced, button, card, disclosure, iconButton, lockButton, row, sectionTitle, selectControl, type Choice, type Row } from './ui.js';
import { contextRows } from './config-sections.js';
import { onPush } from '../rpc.js';
import { activeProvider, allProviders } from '../provider-view.js';
import { dot, picker } from './picker.js';
import type { Ctx, Section } from './ctx.js';

/** A list the page fetched less than this long ago is shown again as it is (opening the picker later asks again) */
const CATALOG_FRESH_MS = 2 * 60_000;
/** The width of the pickers and fields in the card, so their right sides line up */
const FIELD = 300;

export function modelSection(ctx: Ctx): Section {
  const el = h('section', {}, sectionTitle('Models'));
  type Kind = 'ollama' | 'portkey' | 'named';
  const kindOf = (p: string): Kind => (p === 'ollama' || p === 'portkey' ? p : 'named');
  const kindRows: { el: HTMLElement; kind: Kind }[] = [];
  const tag = <T extends { el: HTMLElement }>(r: T, kind: Kind): T => {
    r.el.dataset.provider = kind;
    kindRows.push({ el: r.el, kind });
    return r;
  };
  const cfgNow = () => ctx.config();
  const active = (): ProviderView => activeProvider(cfgNow());
  const activeName = () => cfgNow().provider || 'ollama';
  /** A control and what sits at its right (a status, a button), the pair lined up across the card's rows */
  const pair = (control: HTMLElement, ...side: HTMLElement[]) => h('div', { class: 'sp-pair' }, control, h('div', { class: 'sp-pair-side' }, ...side));

  /** The lock on a control a project's settings.json sets (your own file is written to, so it does not lock) */
  function setLock(r: Row, owner: 'user' | 'project' | null): void {
    let lock = r.control.querySelector<HTMLButtonElement>(':scope > .sp-lock');
    if (owner === 'project') {
      if (!lock) {
        lock = lockButton('', () => ctx.show('developer', { row: 'file-project' }));
        r.control.querySelector('.sp-saved')!.after(lock);
      }
    } else lock?.remove();
  }

  // ---------- The lists of models ----------

  /** Each provider's list, with when it came and what it was asked as (a new key or address asks again) */
  const catalogs = new Map<string, { at: number; sig: string; cat: ProviderCatalog }>();
  /** The latest list request per provider: an older one's result is dropped */
  const pending = new LatestRequests<ProviderCatalog>();
  const sigOf = (p: ProviderView) => [p.type, p.baseURL, p.key, p.keyTail ?? '', p.models.join(','), p.headers.join(',')].join('\u0001');
  const viewOf = (name: string) => allProviders(cfgNow()).find((p) => p.name === name);
  const catOf = (name: string) => catalogs.get(name)?.cat;
  const catMap = () => new Map([...catalogs].map(([n, c]) => [n, c.cat]));

  async function catalog(name: string, force = false): Promise<ProviderCatalog> {
    const p = viewOf(name);
    const sig = p ? sigOf(p) : '';
    const have = catalogs.get(name);
    const inFlight = pending.inFlight(name);
    if (!force && have && have.sig === sig && Date.now() - have.at < CATALOG_FRESH_MS && (!inFlight || inFlight.sig === sig)) return have.cat;
    if (inFlight && !force && inFlight.sig === sig) return inFlight.req;
    const own = p ? [p.model, ...p.models].filter(Boolean) : [];
    const ask = () => ctx.call('providers.catalog', name).catch((err): ProviderCatalog => ({ name, models: own, own, listed: false, error: ctx.cleanError(err) }));
    const req = pending.start(name, sig, ask, (cat) => {
      catalogs.set(name, { at: Date.now(), sig, cat });
      renderCard();
      setCheckChoices();
    });
    renderCard();
    return req;
  }

  // ---------- Provider ----------

  /** "LM Studio" and "lmstudio" name the same thing: no "(lmstudio)" after it */
  const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
  const providerName = (p: ProviderView) =>
    p.name === 'ollama' ? 'Ollama' : p.builtIn ? p.label : p.error?.startsWith('There is no provider') ? `${p.name} (not defined)` : same(p.label, p.name) || p.label.endsWith(`(${p.name})`) ? p.label : `${p.label} (${p.name})`;
  const statusOf = (p: ProviderView) => (pending.has(p.name) && !catOf(p.name) && p.key !== 'missing' ? providerStatus(p, null) : providerStatus(p, catOf(p.name)));

  const providerPicker = picker({
    id: 'provider',
    width: FIELD,
    label: 'Provider',
    list: () => ({
      items: pickableProviders(allProviders(cfgNow()), catMap(), activeName()).map((p) => {
        const st = statusOf(p);
        return { value: p.name, label: providerName(p), dot: st.tone, note: st.word === 'Ready' ? '' : st.word, title: st.reason || providerName(p) };
      }),
    }),
    onPick: (n) => void useProvider(n),
  });
  const statusEl = h('span', { class: 'sp-status', role: 'status' });
  const providerRow = row(
    { id: 'provider', title: 'Provider', keywords: 'ollama portkey gateway local cloud openrouter openai anthropic groq deepseek together lm studio service connected models list test base url endpoint type status ready reachable' },
    pair(providerPicker.el, statusEl),
  );

  async function useProvider(n: string): Promise<void> {
    if (n === activeName()) return;
    providerRow.problem(null);
    try {
      await ctx.call('providers.use', n);
      providerRow.saved();
      void catalog(n);
    } catch (err) {
      providerRow.problem(ctx.cleanError(err));
    }
  }

  function renderProvider(): void {
    const p = active();
    const st = p.error?.startsWith('There is no provider') ? { tone: 'danger' as const, word: 'Not defined', reason: p.error } : statusOf(p);
    providerPicker.show(providerName(p), { dot: st.tone });
    statusEl.innerHTML = `${dot(st.tone)}<span>${escapeHtml(st.word)}</span>`;
    statusEl.title = st.reason;
    // One short line; the whole reason (the address, the service's own words) is its tooltip
    providerRow.setDesc(shortReason(st.reason));
    providerRow.descEl.title = st.reason !== shortReason(st.reason) ? st.reason : '';
    providerRow.descEl.classList.toggle('danger', st.tone === 'danger');
    const owner = ctx.ownerOf('provider');
    setLock(providerRow, owner);
    providerPicker.disable(owner === 'project');
    if (providerPicker.isOpen()) providerPicker.refresh();
  }

  // ---------- Model ----------

  const modelField = (p: ProviderView) => (p.name === 'ollama' ? 'ollama.model' : p.name === 'portkey' ? 'portkey.model' : `providers.${p.name}.model`);
  const modelPicker = picker({
    id: 'provider-model',
    width: FIELD,
    popWidth: 440,
    label: 'Model',
    mono: true,
    search: { placeholder: 'Search, or type a model id' },
    list: (q) => {
      const p = active();
      const cat = catOf(p.name);
      const ids = modelIds(p, cat, [p.model]);
      const m = pickerMatches(ids, q);
      const items = m.shown.map((id) => ({ value: id, label: cutId(id, id === p.model ? 42 : 50), title: id, note: id === p.model ? 'In use' : '' }));
      // What was typed, as it is: first when nothing listed matches, else after the matches (Enter takes the first)
      if (m.typed) items[m.shown.length ? 'push' : 'unshift']({ value: m.typed, label: cutId(m.typed, 38), title: m.typed, note: 'Use as typed' });
      const more = m.matched - m.shown.length;
      const foot = more > 0 ? `${more.toLocaleString('en-US')} more. Type to narrow.` : cat && !cat.listed && !cat.noKey ? "Couldn't list the models. Type an id." : '';
      return { items, foot, empty: pending.has(p.name) ? 'Asking for the list…' : q.trim() ? 'No model matches.' : 'No models listed. Type an id.' };
    },
    onPick: (m) => void setModel(m),
  });
  const testBtn = button('Test', () => void runTest());
  const modelRow = row({ id: 'provider-model', title: 'Model', keywords: 'llm model id tag catalog list refresh choose ollama gateway test answer' }, pair(modelPicker.el, testBtn));
  const modelResult = h('div', { class: 'sp-row-result', role: 'status', hidden: true });
  modelRow.el.append(modelResult);
  // Opening the picker asks for a list that has gone stale
  modelPicker.button.addEventListener('click', () => {
    if (modelPicker.isOpen()) void catalog(active().name).then(() => modelPicker.refresh());
  });

  async function setModel(m: string): Promise<void> {
    const p = active();
    if (m === p.model) return;
    modelRow.problem(null);
    modelResult.hidden = true;
    try {
      await ctx.call('providers.setModel', p.name, m);
      modelRow.saved();
    } catch (err) {
      modelRow.problem(ctx.cleanError(err));
    }
  }

  /** One small live request to the model in use: only ever on this click */
  let testing = false;
  async function runTest(): Promise<void> {
    if (testing) return;
    const p = active();
    testing = true;
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    modelResult.hidden = true;
    try {
      const r = await ctx.call('providers.test', p.name, p.model);
      showResult(testWords(r));
    } catch (err) {
      showResult({ ok: false, text: ctx.cleanError(err) });
    } finally {
      testing = false;
      testBtn.textContent = 'Test';
      renderModel();
    }
  }
  function showResult(r: { ok: boolean; text: string }): void {
    // A failure in one short line; the whole text (the model id, the address) is its tooltip
    const line = r.ok ? r.text : shortReason(r.text);
    modelResult.className = `sp-row-result ${r.ok ? 'ok' : 'danger'}`;
    modelResult.innerHTML = `${icon(r.ok ? 'check' : 'circle-alert', 12)}<span>${escapeHtml(line)}</span>`;
    modelResult.title = r.text;
    modelResult.hidden = false;
  }

  let lastModelKey = '';
  function renderModel(): void {
    const p = active();
    const key = `${p.name}\u0000${p.model}`;
    // Another provider or model: the last test's result was about something else
    if (key !== lastModelKey) {
      lastModelKey = key;
      modelResult.hidden = true;
    }
    modelPicker.show(p.model ? cutId(p.model, 34) : 'Choose a model', { title: p.model || 'No model chosen', placeholder: !p.model });
    modelRow.setDesc(!p.model && !p.error?.startsWith('There is no provider') ? 'Choose a model to start.' : '');
    const owner = ctx.ownerOf(modelField(p));
    setLock(modelRow, owner);
    modelPicker.disable(owner === 'project' || Boolean(p.error?.startsWith('There is no provider')));
    testBtn.disabled = testing || !p.model || p.key === 'missing';
    testBtn.title = p.key === 'missing' ? 'Add its key first.' : 'Sends one short request';
    if (modelPicker.isOpen()) modelPicker.refresh();
  }

  // ---------- API key ----------

  const keyText = h('span', { class: 'sp-key-text' });
  const keyBox = h('span', { class: 'sp-key-box' }, keyText);
  const keyInput = h('input', { type: 'password', class: 'sp-input mono sp-key-input', id: 'provider-apiKey-input', placeholder: 'Paste the key', autocomplete: 'off', spellcheck: 'false', hidden: true });
  const keyField = h('span', { class: 'sp-key-field', style: `width:${FIELD}px` }, keyBox, keyInput);
  const replaceBtn = button('Replace', () => editKey(true));
  const removeBtn = iconButton('trash', 'Remove the key', () => void removeKey());
  const saveKeyBtn = button('Save', () => void saveKey(), { primary: true });
  const cancelKeyBtn = iconButton('x', 'Cancel', () => editKey(false));
  const keyRow = row({ id: 'provider-apiKey', title: 'API key', keywords: 'token secret password credential environment variable portkey key replace remove save' }, pair(keyField, replaceBtn, removeBtn, saveKeyBtn, cancelKeyBtn));
  let editing = false;

  function editKey(on: boolean): void {
    editing = on;
    keyInput.value = '';
    keyRow.problem(null);
    renderKey();
    if (on) keyInput.focus();
  }
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveKey();
    } else if (e.key === 'Escape' && active().key === 'set') {
      e.preventDefault();
      e.stopPropagation();
      editKey(false);
    }
  });

  async function saveKey(): Promise<void> {
    const p = active();
    // The field belongs to the provider it was opened for: one switched since (not yet synced) gets nothing
    if (p.name !== lastActive) {
      keyInput.value = '';
      return;
    }
    const value = keyInput.value.trim();
    if (!value) {
      keyRow.problem('Paste the key.');
      keyInput.focus();
      return;
    }
    saveKeyBtn.disabled = true;
    keyRow.problem(null);
    try {
      await ctx.call('providers.setKey', p.name, value);
      // The field forgets it at once: the page keeps no copy
      keyInput.value = '';
      editing = false;
      keyRow.saved();
      void catalog(p.name, true);
    } catch (err) {
      keyRow.problem(ctx.cleanError(err));
    } finally {
      saveKeyBtn.disabled = false;
      renderKey();
    }
  }

  async function removeKey(): Promise<void> {
    const p = active();
    if (!(await ctx.confirm({ title: 'Remove the key?', description: `${providerName(p)} stops working until you add one.`, confirmLabel: 'Remove', danger: true }))) return;
    keyRow.problem(null);
    try {
      await ctx.call('providers.removeKey', p.name);
      keyRow.saved();
      void catalog(p.name, true);
    } catch (err) {
      keyRow.problem(ctx.cleanError(err));
    }
  }

  function renderKey(): void {
    const p = active();
    const takesKey = p.key !== 'none' || Boolean(p.keyEditable);
    keyRow.el.hidden = !takesKey;
    if (!takesKey) return;
    // No key yet and one can be saved: the field is open
    const open = editing || (p.key === 'missing' && Boolean(p.keyEditable));
    keyBox.hidden = open;
    keyInput.hidden = !open;
    keyText.textContent = keyShown(p);
    keyBox.classList.toggle('none', p.key !== 'set');
    keyBox.title = p.key === 'set' ? (p.keyFrom === 'shell' || p.keyFrom === 'project' ? `${keyFromWords(p)} (${p.keySource})` : keyFromWords(p)) : '';
    // A key from your shell or a project's settings.json is read-only here: the lock says where it comes from
    const readOnly = p.key === 'set' && !p.keyEditable && (p.keyFrom === 'shell' || p.keyFrom === 'project');
    keyBox.classList.toggle('locked', readOnly);
    keyBox.querySelector('.sp-lock')?.remove();
    if (readOnly) {
      const where = p.keyFrom === 'shell' ? `Set in your shell${p.keySource ? ` (${p.keySource})` : ''}` : `Set in this project's settings.json${p.keySource ? ` (${p.keySource})` : ''}`;
      const lock: HTMLElement =
        p.keyFrom === 'project' ? lockButton('', () => ctx.show('developer', { row: 'file-project' })) : h('span', { class: 'sp-lock', role: 'img', html: icon('lock', 13) });
      lock.title = where;
      lock.setAttribute('aria-label', where);
      keyBox.append(lock);
    }
    replaceBtn.hidden = open || !p.keyEditable;
    replaceBtn.textContent = p.key === 'set' ? 'Replace' : 'Add';
    removeBtn.hidden = open || !p.keyRemovable;
    saveKeyBtn.hidden = !open;
    cancelKeyBtn.hidden = !open || p.key !== 'set';
    if (!editing) keyRow.setDesc(keyFromWords(p));
  }

  // ---------- Connection: the address and the rest, per kind of provider ----------

  const ollamaRows = [
    tag(ctx.textField({ id: 'ollama-baseURL', inputId: 'ollama-baseURL', title: 'Base URL', keywords: 'endpoint address server host ollama', field: 'ollama.baseURL', placeholder: 'http://localhost:11434/v1', mono: true, width: FIELD, parse: parseUrl }), 'ollama'),
    tag(
      ctx.textField({
        id: 'ollama-numCtx',
        inputId: 'ollama-numCtx',
        title: 'Context size',
        desc: 'Tokens of context to ask for.',
        keywords: 'num_ctx tokens window memory ollama',
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
        desc: 'For models that reason first.',
        keywords: 'reasoning think ollama',
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

  const pk = (o: Parameters<Ctx['textField']>[0]) => tag(ctx.textField({ mono: true, width: FIELD, ...o, keywords: `${o.keywords ?? ''} gateway portkey` }), 'portkey');
  const gatewayRows = [
    pk({ id: 'portkey-baseURL', inputId: 'portkey-baseURL', title: 'Base URL', keywords: 'endpoint address server host', field: 'portkey.baseURL', placeholder: 'https://api.portkey.ai/v1', parse: parseUrl }),
    pk({ id: 'portkey-contextWindow', inputId: 'portkey-contextWindow', title: 'Context window', desc: "The model's window, in tokens.", keywords: 'tokens size memory', field: 'portkey.contextWindow', type: 'number', mono: false, width: 120, parse: (t) => parseInteger(t, 1024, 10_000_000) }),
    pk({ id: 'portkey-virtualKey', inputId: 'portkey-virtualKey', title: 'Virtual key', desc: 'Sent as x-portkey-virtual-key.', keywords: 'advanced routing', field: 'portkey.virtualKey', placeholder: 'Optional', parse: parseText }),
    pk({ id: 'portkey-provider', inputId: 'portkey-provider', title: 'Provider slug', desc: 'Sent as x-portkey-provider.', keywords: 'advanced routing', field: 'portkey.provider', placeholder: 'Optional', parse: parseText }),
    pk({ id: 'portkey-providerApiKey', inputId: 'portkey-providerApiKey', title: 'Provider API key', desc: "That provider's own key.", keywords: 'advanced routing token secret bearer authorization', field: 'portkey.providerApiKey', type: 'password', placeholder: 'Optional', parse: parseText }),
    pk({ id: 'portkey-configId', inputId: 'portkey-configId', title: 'Config ID', desc: 'Sent as x-portkey-config.', keywords: 'advanced routing fallback cache', field: 'portkey.configId', placeholder: 'pc-…', parse: parseText }),
  ];

  const baseRow = tag(row({ id: 'provider-baseURL', title: 'Base URL', keywords: 'endpoint address server host type service' }, null), 'named');
  baseRow.descEl.classList.add('sp-path');
  const windowRow = tag(row({ id: 'provider-contextWindow', title: 'Context window', keywords: 'tokens size memory' }, null), 'named');
  const removeProviderBtn = button('Remove…', () => void removeProvider(), { danger: true });
  const removeRow = tag(row({ id: 'provider-remove', title: 'Remove provider', keywords: 'delete provider forget' }, removeProviderBtn), 'named');

  async function removeProvider(): Promise<void> {
    const p = active();
    if (!(await ctx.confirm({ title: `Remove ${providerName(p)}?`, description: 'Its entry and saved key leave your settings.', confirmLabel: 'Remove', danger: true }))) return;
    removeRow.problem(null);
    try {
      await ctx.call('providers.remove', p.name);
      catalogs.delete(p.name);
    } catch (err) {
      removeRow.problem(ctx.cleanError(err));
    }
  }

  const connection = disclosure('Connection', { cls: 'sp-connection' }, ...ollamaRows, ...gatewayRows, baseRow, windowRow, removeRow);

  function renderConnection(): void {
    const p = active();
    const k = kindOf(p.name);
    for (const r of kindRows) r.el.classList.toggle('provider-off', r.kind !== k);
    if (k !== 'named') return;
    baseRow.setDesc(p.baseURL || 'No base URL');
    baseRow.descEl.title = p.baseURL;
    windowRow.setDesc(`${p.contextWindow.toLocaleString('en-US')} tokens${p.maxOutput ? `, replies up to ${p.maxOutput.toLocaleString('en-US')}` : ''}`);
    removeRow.el.hidden = !p.removable;
  }

  // ---------- Add provider ----------

  const addBtn = button('Add provider', () => openAdd(), { icon: 'plus' });
  addBtn.classList.add('sp-add-provider-btn');
  const addRow = row({ id: 'provider-add', title: 'Add provider', bare: true, keywords: 'add provider new more providers openrouter openai anthropic groq deepseek together lmstudio lm studio openai-compatible ollama portkey gateway cli command settings.json configure key' }, addBtn);

  let presets: ProviderPresetInfo[] = [];
  const typeChoices: Choice<string>[] = [];
  const typeSelect = selectControl(typeChoices, '', () => syncAddForm(true), FIELD);
  typeSelect.select.id = 'provider-add-type';
  const nameInput = h('input', { type: 'text', class: 'sp-input mono', id: 'provider-add-name', spellcheck: 'false', autocomplete: 'off', style: `width:${FIELD}px` });
  const addKeyInput = h('input', { type: 'password', class: 'sp-input mono', id: 'provider-add-key', placeholder: 'Paste the key', spellcheck: 'false', autocomplete: 'off', style: `width:${FIELD}px` });
  const urlInput = h('input', { type: 'text', class: 'sp-input mono', id: 'provider-add-url', placeholder: 'https://example.com/v1', spellcheck: 'false', autocomplete: 'off', style: `width:${FIELD}px` });
  const line = (label: string, control: HTMLElement) => {
    const l = h('label', { class: 'sp-form-line' }, h('span', { class: 'sp-form-label' }, label), control);
    return l;
  };
  const nameLine = line('Name', nameInput);
  const keyLine = line('API key', addKeyInput);
  const urlLine = line('Base URL', urlInput);
  const addError = h('div', { class: 'sp-problem', role: 'alert', hidden: true });
  const submitBtn = button('Add', () => void submitAdd(), { primary: true });
  const addForm = h(
    'form',
    { class: 'sp-add-form', id: 'provider-add-form', hidden: true },
    line('Type', typeSelect),
    nameLine,
    keyLine,
    urlLine,
    addError,
    h('div', { class: 'sp-form-actions' }, button('Cancel', () => closeAdd()), submitBtn),
  );
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitAdd();
  });
  addForm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAdd();
    }
  });

  const presetOf = () => presets.find((x) => x.type === typeSelect.select.value);
  /** The gateway type fills the built-in block while that has no key */
  const fillsBlock = (t: string) => t === 'ollama' || (t === 'portkey' && viewOf('portkey')?.key === 'missing');

  async function openAdd(): Promise<void> {
    addError.hidden = true;
    if (!presets.length) {
      try {
        presets = await ctx.call('providers.presets');
      } catch (err) {
        addRow.problem(ctx.cleanError(err));
        return;
      }
      typeChoices.splice(0, typeChoices.length, ...presets.map((x) => ({ value: x.type, label: x.label })));
      typeSelect.select.replaceChildren(...typeChoices.map((c) => h('option', { value: c.value }, c.label)));
    }
    typeSelect.set(typeChoices[0]?.value ?? '');
    addKeyInput.value = '';
    urlInput.value = '';
    syncAddForm(true);
    addForm.hidden = false;
    addRow.el.hidden = true;
    typeSelect.select.focus();
  }

  function closeAdd(): void {
    addKeyInput.value = '';
    addForm.hidden = true;
    addRow.el.hidden = false;
    addBtn.focus();
  }

  function syncAddForm(newType: boolean): void {
    const pre = presetOf();
    const t = pre?.type ?? '';
    const block = fillsBlock(t);
    nameLine.hidden = block;
    if (newType) nameInput.value = suggestName(t, allProviders(cfgNow()).map((p) => p.name));
    const wantsKey = t !== 'ollama' && t !== 'lmstudio';
    keyLine.hidden = !wantsKey;
    addKeyInput.placeholder = !pre?.keyRequired ? 'Optional' : pre.keyInEnv ? `Optional: ${pre.keyEnv} is set` : 'Paste the key';
    urlLine.hidden = t !== 'openai-compatible';
    submitBtn.textContent = t === 'ollama' ? 'Use Ollama' : 'Add';
    syncAddReady();
  }

  /** Add is the form's main action: the primary style once the form can be sent, plainly disabled until then */
  let adding = false;
  function syncAddReady(): void {
    const pre = presetOf();
    const t = pre?.type ?? '';
    const block = fillsBlock(t);
    const ready = addFormReady({
      type: t,
      askName: !block,
      name: nameInput.value,
      taken: allProviders(cfgNow()).map((p) => p.name),
      keyNeeded: !keyLine.hidden && (block ? t === 'portkey' : Boolean(pre?.keyRequired) && !pre?.keyInEnv),
      key: addKeyInput.value,
      askUrl: !urlLine.hidden,
      url: urlInput.value,
    });
    submitBtn.disabled = adding || !ready;
    submitBtn.classList.toggle('primary', ready);
  }
  for (const input of [nameInput, addKeyInput, urlInput]) input.addEventListener('input', () => syncAddReady());

  async function submitAdd(): Promise<void> {
    if (submitBtn.disabled) return;
    const t = typeSelect.select.value;
    addError.hidden = true;
    adding = true;
    submitBtn.disabled = true;
    try {
      const res = await ctx.call('providers.add', { type: t, name: nameInput.value.trim(), apiKey: addKeyInput.value, baseURL: urlInput.value.trim() });
      addKeyInput.value = '';
      closeAdd();
      addRow.saved();
      providerRow.problem(res.note ?? null);
      void catalog(res.name, true);
    } catch (err) {
      addError.innerHTML = `${icon('circle-alert', 14)}<span>${escapeHtml(ctx.cleanError(err))}</span>`;
      addError.hidden = false;
    } finally {
      adding = false;
      syncAddReady();
    }
  }

  // ---------- Advanced: thinking, the safety check, context ----------

  const thinkRow = ctx.switchField({ id: 'thinking', title: 'Think before acting', keywords: 'thinking reasoning reason adaptive claude code extended faster cheaper cost effort anthropic', field: 'thinking', values: { on: 'auto', off: 'off' } });
  function renderThinking(): void {
    const p = active();
    thinkRow.setDesc(thinkingWords(p));
    // Only where it applies; elsewhere a search still finds it, with the line that says where it does
    thinkRow.el.classList.toggle('provider-off', !p.native);
  }

  /** What the check runs on now (auto.checkModel), null until asked or when this build has no check */
  let checkInfo: CheckModelInfo | null = null;
  const checkList: Choice<string>[] = [];
  const checkRow = ctx.selectField({
    id: 'autoMode-model',
    inputId: 'autoMode-model',
    title: 'Safety check model',
    keywords: 'auto mode safety check classifier judge model haiku same as the session eval test accuracy run false allow block',
    field: 'autoMode.model',
    width: FIELD,
    choices: checkList,
    read: (v) => String(v ?? ''),
    onSaved: () => {
      checkResult.hidden = true;
      void refreshCheck();
    },
  });
  const checkBtn = button('Test', () => void runCheck());
  checkRow.control.append(checkBtn);
  checkRow.control.classList.add('sp-pair-row');
  const checkResult = h('div', { class: 'sp-row-result', role: 'status', hidden: true });
  checkRow.el.append(checkResult);

  /** The select's choices: "Same as the session", then each usable provider's models */
  const setCheckChoices = () => {
    const cfg = cfgNow();
    const name = activeName();
    const checkOn = (n: string) => (checkInfo && !checkInfo.none && checkInfo.provider === n ? (checkInfo.model ?? '') : '');
    const groups = allProviders(cfg).map((p) => ({ name: p.name, label: p.label, usable: p.key !== 'missing', models: modelIds(p, catOf(p.name), [p.name === name ? p.model : '', checkOn(p.name)].filter(Boolean)) }));
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

  let checkRunning = false;
  let mine = false;
  const setChecking = (on: boolean, done = 0, total = checkInfo?.testCount ?? 0) => {
    checkRunning = on;
    checkBtn.textContent = on ? 'Stop' : 'Test';
    if (on) checkRow.setDesc(`Checking ${Math.min(done + 1, Math.max(total, 1))} of ${total}…`);
    else renderCheck();
  };
  onPush('auto:check-test', (p) => {
    if (p.running) setChecking(true, p.done, p.total);
    else if (!mine) setChecking(false);
  });
  /** The test: only on this click. The button's tooltip says beforehand how many requests it sends */
  async function runCheck(): Promise<void> {
    if (checkRunning) {
      void ctx.call('auto.checkTestCancel').catch(() => undefined);
      return;
    }
    mine = true;
    checkRow.problem(null);
    checkResult.hidden = true;
    setChecking(true, 0);
    try {
      const r = await ctx.call('auto.checkTest');
      const l = checkLine(r);
      const w = checkTestWords(r);
      checkResult.className = `sp-row-result ${l.tone}`;
      checkResult.innerHTML = `${icon(l.tone === 'ok' ? 'check' : l.tone === 'danger' ? 'circle-alert' : 'clock', 12)}<span>${escapeHtml(l.text)}</span>`;
      checkResult.title = [w.headline, ...w.lines.map((x) => x.text), `Tested on ${r.model}.`].join('\n');
      checkResult.hidden = false;
    } catch (err) {
      checkRow.problem(ctx.cleanError(err));
    } finally {
      mine = false;
      setChecking(false);
    }
  }
  function renderCheck(): void {
    if (checkRunning) return;
    checkRow.setDesc(checkDesc(checkInfo));
    const select = checkRow.control.querySelector('select');
    if (select) select.title = checkModelWords(checkInfo);
    checkBtn.disabled = !checkInfo || checkInfo.none;
    checkBtn.title = checkTestPlan(checkInfo);
  }
  async function refreshCheck(): Promise<void> {
    try {
      checkInfo = await ctx.call('auto.checkModel');
    } catch (err) {
      checkInfo = null;
      if (ctx.isUnknown(err)) {
        checkRow.el.hidden = true;
        return;
      }
    }
    renderCheck();
    setCheckChoices();
  }

  // ---------- The page ----------

  el.append(
    card(null, providerRow, modelRow, keyRow, connection, addRow, addForm),
    pageAdvanced('model', card(null, thinkRow, checkRow), card('Context', ...contextRows(ctx))),
  );

  function renderCard(): void {
    renderProvider();
    renderModel();
    renderKey();
    renderConnection();
  }

  /** Every provider's list, so the picker knows which are set up and the status is current */
  const loadAll = (force = false) => {
    for (const p of allProviders(cfgNow())) if (p.key !== 'missing') void catalog(p.name, force);
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

  let lastActive = '';
  function syncAll(cfg: AppConfig): void {
    if (activeName() !== lastActive) {
      lastActive = activeName();
      editing = false;
      // A key typed for one provider never reopens for the next one
      keyInput.value = '';
      keyRow.problem(null);
    }
    renderCard();
    renderThinking();
    setCheckChoices();
    // A provider whose key or address changed is asked again, also while a request made before the change is out
    for (const p of allProviders(cfg)) {
      if (p.key !== 'missing' && pending.askAgain(p.name, sigOf(p), catalogs.get(p.name)?.sig)) void catalog(p.name);
    }
  }

  return {
    id: 'model',
    el,
    sync(cfg) {
      syncAll(cfg);
      void refreshCheck();
    },
    async load() {
      syncAll(cfgNow());
      void refreshCheck();
      listsWanted = true;
      loadWhenShown();
      return 'ok';
    },
    closed() {
      providerPicker.close();
      modelPicker.close();
      editing = false;
      keyInput.value = '';
      addKeyInput.value = '';
      addForm.hidden = true;
      addRow.el.hidden = false;
    },
  };
}
