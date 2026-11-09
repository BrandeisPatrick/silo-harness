import { looksLikeCredentialLabel, MASK, scrubSecrets } from '../browser/safety';
import type { Tool, ToolContext, ToolResult } from './types';

/** The values of the page's filled credential fields; none when the page (or a test's stand-in) cannot say. */
async function secrets(ctx: ToolContext): Promise<string[]> {
  try {
    return await ctx.browser.secretValues();
  } catch {
    return [];
  }
}

/**
 * Every browser tool's result and error pass through here: the values of the page's credential fields, read before
 * and after the call (browser_eval may change or clear them), come out as •••, whatever the call returned.
 */
function guarded(tool: Tool): Tool {
  const run = tool.run;
  return {
    ...tool,
    run: async (args, ctx): Promise<ToolResult> => {
      const before = await secrets(ctx);
      try {
        const r = await run(args, ctx);
        return { ...r, content: scrubSecrets(r.content, [...before, ...(await secrets(ctx))]) };
      } catch (err) {
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), [...before, ...(await secrets(ctx))]));
      }
    },
  };
}

/** One line per tab for browser_tabs list: the active one marked. */
function tabLines(tabs: { id: string; title: string; url: string; loading: boolean }[], activeId: string): string {
  return tabs
    .map((t) => `${t.id === activeId ? '*' : ' '} ${t.id}  ${t.title ? `"${t.title}"  ` : ''}${t.url || 'about:blank'}${t.loading ? '  (loading)' : ''}${t.id === activeId ? '  (active)' : ''}`)
    .join('\n');
}

const tools: Tool[] = [
  {
    name: 'browser_tabs',
    description:
      'The browser pane\'s tabs: list; new (opens url, or a blank tab; background=true leaves the current tab in front); select (tab_id); close (tab_id, default the active tab). Every other browser_* tool acts on the active tab.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        url: { type: 'string', description: 'For new: the URL or search to open' },
        tab_id: { type: 'string', description: 'For select and close, e.g. tab-2' },
        background: { type: 'boolean', description: 'For new: do not switch to the tab' },
      },
      required: ['action'],
    },
    readOnly: true,
    run: async (args, ctx) => {
      const b = ctx.browser;
      const action = String(args.action ?? 'list');
      const list = () => {
        const s = b.state();
        return `${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}:\n${tabLines(s.tabs, s.activeId)}`;
      };
      if (action === 'list') return { content: list() };
      if (action === 'new') {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) {
          const t = b.newTab(undefined, { background: Boolean(args.background) });
          return { content: `Opened ${t.id}, a blank tab${args.background ? ', in the background' : ''}.` };
        }
        return { content: await b.openTab(url, { background: Boolean(args.background) }) };
      }
      if (action === 'select') {
        if (!args.tab_id) throw new Error('select needs tab_id (see list).');
        b.activate(String(args.tab_id));
        const s = b.state();
        return { content: `Now on ${s.activeId}: ${s.url}${s.title ? ` — "${s.title}"` : ''}` };
      }
      if (action === 'close') {
        const id = args.tab_id ? String(args.tab_id) : b.state().activeId;
        b.closeTab(id);
        return { content: `Closed ${id}.\n${list()}` };
      }
      throw new Error(`Unknown action "${action}": use list, new, select or close.`);
    },
  },
  {
    name: 'browser_navigate',
    description: 'Open a URL in the built-in browser pane and wait for it to load. Also accepts "back", "forward", or a path relative to the current page (e.g. "form.html"). A bare search phrase is sent to DuckDuckGo.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL, "back", "forward", or search terms' } }, required: ['url'] },
    run: async (args, ctx) => ({ content: await ctx.browser.navigate(String(args.url)) }),
  },
  {
    name: 'browser_get_text',
    description: 'Return the visible text of the current page (main content first). Best for reading articles and docs.',
    parameters: { type: 'object', properties: { max_chars: { type: 'integer', description: 'Maximum characters to return (default 50000)' } } },
    run: async (args, ctx) => ({ content: await ctx.browser.getText(Number(args.max_chars) || 50_000) }),
  },
  {
    name: 'browser_read_page',
    description:
      'Outline the current page as a list of visible interactive elements, each tagged with a ref id like [ref_3] that browser_click and browser_type accept. filter="all" also includes headings and text. Password, one-time code and card fields never show their value: a filled one reads = "•••", an empty one (empty).',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive (default) or all' },
        max_chars: { type: 'integer', description: 'Maximum characters to return (default 40000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.readPage(args.filter === 'all' ? 'all' : 'interactive', Number(args.max_chars) || 40_000),
    }),
  },
  {
    name: 'browser_find',
    description: 'Search the current page for elements or text containing a phrase (case-insensitive). Returns matching outline lines with refs.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to look for, e.g. "Sign in"' } }, required: ['query'] },
    run: async (args, ctx) => ({ content: await ctx.browser.find(String(args.query)) }),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its visible text (e.g. "Sign in"), by its ref from browser_read_page, or at viewport coordinates.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text or label of the element to click (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_3' },
        x: { type: 'number', description: 'Viewport x in CSS pixels (when no ref)' },
        y: { type: 'number', description: 'Viewport y in CSS pixels (when no ref)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: 'Double-click' },
      },
    },
    run: async (args, ctx) => {
      const button = (['left', 'right', 'middle'].includes(args.button) ? args.button : 'left') as 'left' | 'right' | 'middle';
      const ref = args.ref ? String(args.ref) : args.text ? await ctx.browser.findRef(String(args.text), 'any') : '';
      if (ref) return { content: await ctx.browser.click(ref, button, Boolean(args.double)) };
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        ctx.browser.clickAt(args.x, args.y, button, args.double ? 2 : 1);
        await new Promise((r) => setTimeout(r, 400));
        return { content: `Clicked at (${args.x}, ${args.y}).` };
      }
      throw new Error('Provide text, a ref, or x and y.');
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into a field chosen by its label or placeholder (field), by ref, or into whatever currently has focus. Replaces existing content unless clear=false. Set submit=true to press Enter afterwards. Into a password, one-time code or card field the text is typed but never repeated: the result gives only its length, and the transcript shows it as •••.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Label or placeholder of the field to type into (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_5' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Clear the field first (default true)' },
      },
      required: ['text'],
    },
    // The text to type into a credential field stays out of the transcript, the tool row and hooks from the start.
    shownArgs: async (args, ctx) => {
      if (typeof args?.text !== 'string' || !args.text) return null;
      const hidden = { ...args, text: MASK };
      if (typeof args.field === 'string' && looksLikeCredentialLabel(args.field)) return hidden;
      if (!ctx.foreground()) return null;
      const kind = await ctx.browser.credentialTarget(args.ref ? String(args.ref) : undefined, args.field ? String(args.field) : undefined).catch(() => null);
      return kind ? hidden : null;
    },
    run: async (args, ctx) => {
      const ref = args.ref ? String(args.ref) : args.field ? await ctx.browser.findRef(String(args.field), 'field') : undefined;
      const r = await ctx.browser.type(ref, String(args.text), Boolean(args.submit), args.clear !== false);
      return r.secret ? { content: r.content, hiddenArgs: { ...args, text: MASK } } : { content: r.content };
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until the page shows some text or an element matching a CSS selector (default timeout 10 s). Use after clicks that load or update content.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text that must appear on the page (case-insensitive)' },
        selector: { type: 'string', description: 'CSS selector that must match an element' },
        timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds (default 10000, max 60000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.waitFor(args.text ? String(args.text) : undefined, args.selector ? String(args.selector) : undefined, Number(args.timeout_ms) || 10_000),
    }),
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or shortcut in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "cmd+a".',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async (args, ctx) => ({ content: await ctx.browser.pressKey(String(args.key)) }),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 600)' },
      },
      required: ['direction'],
    },
    run: async (args, ctx) => ({ content: await ctx.browser.scroll(args.direction, Number(args.amount) || 600) }),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the browser pane as a PNG. The image is shown to the user and saved to disk; it is also sent to the model when screenshots-to-model is enabled in Settings. Refused while a filled password, one-time code or card field has the focus or shows its value on screen.',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      const shot = await ctx.browser.screenshot();
      return { content: `Screenshot saved to ${shot.path} (${shot.width}x${shot.height}). To put it in your reply for the user, pass this path to show_image.`, image: shot.dataUrl };
    },
  },
  {
    name: 'browser_eval',
    description:
      'Run JavaScript in the current page and return the result as JSON. Use for inspection and data extraction. The values of password, one-time code and card fields are hidden: wherever one appears in the result it reads •••.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression or IIFE' } }, required: ['code'] },
    run: async (args, ctx) => ({ content: await ctx.browser.evaluate(String(args.code)) }),
  },
];

export const browserTools: Tool[] = tools.map(guarded);
