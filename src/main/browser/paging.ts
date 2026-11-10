// The page's text and outline come to the model in pieces: DEFAULT_READ characters at a time (about 3,000 tokens),
// from `start`, with one line at the end saying how much is left and how to get it. Pure, for the tests.

/** How many characters browser_get_text and browser_read_page return when the call does not say. */
export const DEFAULT_READ = 12_000;

/** "12,000" */
const n = (v: number): string => v.toLocaleString('en-US');

/**
 * The piece of `text` from `start` (clamped) of at most `max` characters, and the line that ends a cut piece:
 * "… 31,400 more characters: call again with start=12000". `more` is set when the source itself was cut short.
 */
export function readPiece(text: string, start = 0, max = DEFAULT_READ, more = false): string {
  const all = String(text ?? '');
  const from = Math.min(Math.max(0, Math.floor(Number(start) || 0)), all.length);
  const size = Math.max(1, Math.floor(Number(max) || DEFAULT_READ));
  const end = Math.min(all.length, from + size);
  const piece = all.slice(from, end);
  const left = all.length - end;
  if (left > 0) return `${piece}\n… ${n(left)}${more ? '+' : ''} more characters: call again with start=${end}`;
  if (more) return `${piece}\n… the page has more than this; use browser_find to locate specific elements`;
  return piece;
}
