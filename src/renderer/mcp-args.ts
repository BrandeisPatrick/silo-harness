// An MCP call's arguments on its approval card, readable: a key and value list when every value is a scalar or a
// string (strings with their real line breaks, a long one scrolling inside its box, nothing cut), today's JSON for
// anything nested. Every character a server or the model could use to hide text (control, bidi, zero-width) is shown
// escaped. Pure and import-free, so test/mcp-ui.js loads it as is.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A string, so the compiler cannot turn the escapes into the characters themselves (U+2028 would end the line).
// Tabs and line breaks are kept: a value's own lines are what the user should read.
const HIDDEN = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

/** Text with its hidden characters shown as \u{…}, line breaks kept. */
export function showHidden(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** The arguments as an object, from the call's own arguments or the card's JSON detail; null when neither is one. */
export function argsObject(args: unknown, detail: string): Record<string, unknown> | null {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  if (obj(args) && Object.keys(args as object).length) return obj(args);
  try {
    return obj(JSON.parse(detail));
  } catch {
    return null;
  }
}

/** Whether the arguments read as a flat list: every value a string, number, boolean or null. */
export function isFlat(o: Record<string, unknown>): boolean {
  return Object.values(o).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
}

/** The key and value list's markup, or null when the arguments are nested (the card shows its JSON then). */
export function argsListHtml(o: Record<string, unknown>): string | null {
  const keys = Object.keys(o);
  if (!keys.length || !isFlat(o)) return null;
  const rows = keys.map((k) => {
    const v = o[k];
    const text = typeof v === 'string' ? showHidden(v) : JSON.stringify(v);
    const cls = typeof v === 'string' ? (v.includes('\n') || v.length > 80 ? 'mcp-arg-value long' : 'mcp-arg-value') : 'mcp-arg-value literal';
    return `<dt class="mcp-arg-key">${esc(showHidden(k))}</dt><dd class="${cls}">${esc(text)}</dd>`;
  });
  return `<dl class="mcp-args">${rows.join('')}</dl>`;
}
