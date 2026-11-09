// Hand-drawn 16px stroke icons (1.5px stroke, currentColor, round caps and joins).
// Every path is authored on a 16x16 grid; nothing here is copied from an icon font or library.

const GEAR =
  'M6.49 3.34L6.76 1.62A6.5 6.5 0 0 1 9.24 1.62L9.51 3.34A4.9 4.9 0 0 1 11.28 4.36L12.91 3.74A6.5 6.5 0 0 1 14.15 5.88L12.79 6.98A4.9 4.9 0 0 1 12.79 9.02L14.15 10.12A6.5 6.5 0 0 1 12.91 12.26L11.28 11.64A4.9 4.9 0 0 1 9.51 12.66L9.24 14.38A6.5 6.5 0 0 1 6.76 14.38L6.49 12.66A4.9 4.9 0 0 1 4.72 11.64L3.09 12.26A6.5 6.5 0 0 1 1.85 10.12L3.21 9.02A4.9 4.9 0 0 1 3.21 6.98L1.85 5.88A6.5 6.5 0 0 1 3.09 3.74L4.72 4.36A4.9 4.9 0 0 1 6.49 3.34Z';
const PAGE = 'M9 1.75H4.25c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V6L9 1.75z';
const dot = (cx: number, cy: number, r = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const ICONS = {
  'panel-left': '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M6.25 2.75v10.5"/>',
  // The details rail (as Claude Code draws it): a list inside a box
  'panel-list': '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M5 6.25h6M5 8.75h6M5 11.25h3.5"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  search: '<circle cx="7.25" cy="7.25" r="4.5"/><path d="M10.6 10.6l2.9 2.9"/>',
  settings: `<path d="${GEAR}"/><circle cx="8" cy="8" r="2"/>`,
  trash: '<path d="M2.75 4.25h10.5M6.25 4.25V3c0-.55.45-1 1-1h1.5c.55 0 1 .45 1 1v1.25M4.25 4.25l.6 8.55c.05.66.6 1.2 1.25 1.2h3.8c.66 0 1.2-.54 1.25-1.2l.6-8.55M6.75 7v4M9.25 7v4"/>',
  'git-branch': '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1c0 1.1.9 2 2 2h3c1.1 0 2-.9 2-2V5M8 8v3"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.6 1.65 2.5 3.8 2.5 6s-.9 4.35-2.5 6c-1.6-1.65-2.5-3.8-2.5-6S6.4 3.65 8 2z"/>',
  'arrow-up': '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  'arrow-down': '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
  square: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  // The chat bar: a full-size plus (attach), the return glyph (send) and a 12px stop square
  'plus-lg': '<path d="M8 1.5v13M1.5 8h13" stroke-width="1.25"/>',
  'corner-down-left': '<path d="M14.5 2.25v7H1.5M5.25 5.25l-3.75 4 3.75 4"/>',
  stop: '<rect x="2" y="2" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  'chevron-right': '<path d="M6.25 3.75L10.5 8l-4.25 4.25"/>',
  'chevron-down': '<path d="M3.75 6.25L8 10.5l4.25-4.25"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  check: '<path d="M3.25 8.25l3 3 6.5-6.5"/>',
  refresh: '<path d="M13.25 8A5.25 5.25 0 1 1 8 2.75c1.4 0 2.75.55 3.75 1.5l1.5 1.5M13.25 2.5v3.25H10"/>',
  'arrow-left': '<path d="M13 8H3.5M7.5 4L3.5 8l4 4"/>',
  'arrow-right': '<path d="M3 8h9.5M8.5 4l4 4-4 4"/>',
  'external-link': '<path d="M12.5 9.25v3.25c0 .83-.67 1.5-1.5 1.5H3.5c-.83 0-1.5-.67-1.5-1.5V5c0-.83.67-1.5 1.5-1.5h3.25M9.75 2H14v4.25M14 2L7.5 8.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  folder: '<path d="M2 4.5C2 3.67 2.67 3 3.5 3h2.67c.4 0 .78.16 1.06.44L8.5 4.75h4c.83 0 1.5.67 1.5 1.5v5.25c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5v-7z"/>',
  terminal: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M4.75 6.25L6.75 8l-2 1.75M8.75 10h2.5"/>',
  file: `<path d="${PAGE}"/><path d="M9 1.75V6h4.25"/>`,
  'file-text': `<path d="${PAGE}"/><path d="M9 1.75V6h4.25M5.75 8.75h4.5M5.75 11.25h3"/>`,
  'file-plus': `<path d="${PAGE}"/><path d="M9 1.75V6h4.25M8 8.25v3.5M6.25 10h3.5"/>`,
  pencil: '<path d="M11 2.5a1.77 1.77 0 0 1 2.5 2.5L5.5 13l-3 .5.5-3 8-8zM9.5 4l2.5 2.5"/>',
  list: `<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/>${dot(3, 4, 0.9)}${dot(3, 8, 0.9)}${dot(3, 12, 0.9)}`,
  // Filter (three bars, shorter each) and sort (an arrow down and an arrow up): the page toolbars
  filter: '<path d="M2.75 4.25h10.5M4.75 8h6.5M6.75 11.75h2.5"/>',
  sort: '<path d="M5 2.75v10.5M2.75 10.75L5 13.25l2.25-2.5M11 13.25V2.75M8.75 5.25L11 2.75l2.25 2.5"/>',
  'search-code': '<circle cx="7" cy="7" r="5"/><path d="M10.6 10.6L14 14M5.75 5.5L4.5 7l1.25 1.5M8.25 5.5L9.5 7 8.25 8.5"/>',
  sparkles:
    '<path d="M6.5 2.25c.35 2.6 1.65 3.9 4.25 4.25-2.6.35-3.9 1.65-4.25 4.25-.35-2.6-1.65-3.9-4.25-4.25 2.6-.35 3.9-1.65 4.25-4.25z"/><path d="M12 9.75c.15 1.1.65 1.6 1.75 1.75-1.1.15-1.6.65-1.75 1.75-.15-1.1-.65-1.6-1.75-1.75 1.1-.15 1.6-.65 1.75-1.75z"/>',
  eye: '<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="2"/>',
  'mouse-pointer': '<path d="M3 2.5l3.8 10.5 1.6-4.5 4.5-1.6L3 2.5zM8.4 8.5l4 4"/>',
  keyboard: '<rect x="1.5" y="3.75" width="13" height="8.5" rx="1.75"/><path d="M4.25 6.5h.01M6.75 6.5h.01M9.25 6.5h.01M11.75 6.5h.01M5.5 9.5h5"/>',
  scroll: '<path d="M8 2.25v11.5M5.5 4.75L8 2.25l2.5 2.5M5.5 11.25L8 13.75l2.5-2.5"/>',
  camera: '<path d="M2 5.75c0-.83.67-1.5 1.5-1.5h1.25L6 2.5h4l1.25 1.75h1.25c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5v-6z"/><circle cx="8" cy="8.5" r="2.25"/>',
  code: '<path d="M5.25 4.5L1.75 8l3.5 3.5M10.75 4.5L14.25 8l-3.5 3.5"/>',
  'circle-alert': '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.75M8 11.25h.01"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 4.75h.01"/>',
  'circle-help': '<circle cx="8" cy="8" r="6.25"/><path d="M6.3 6.3a1.8 1.8 0 0 1 3.5.55c0 1.2-1.8 1.55-1.8 2.65M8 11.4h.01"/>',
  'shield-check': '<path d="M8 1.75l5.25 2v3.75c0 3.05-2.2 5.6-5.25 6.75-3.05-1.15-5.25-3.7-5.25-6.75V3.75L8 1.75z"/><path d="M5.75 8l1.5 1.5 3-3"/>',
  zap: '<path d="M9 1.75L3.25 9.25h4.25l-.5 5 5.75-7.5H8.5l.5-5z"/>',
  more: `${dot(3.5, 8)}${dot(8, 8)}${dot(12.5, 8)}`,
  lightbulb: '<path d="M6 12h4M6.5 14h3M8 2a4 4 0 0 0-2.4 7.2c.45.34.9.95.9 1.5V11h3v-.3c0-.55.45-1.16.9-1.5A4 4 0 0 0 8 2z"/>',
  files: '<path d="M10.5 1.75H6.75c-.83 0-1.5.67-1.5 1.5v7.5c0 .83.67 1.5 1.5 1.5h5.5c.83 0 1.5-.67 1.5-1.5V5l-3.25-3.25z"/><path d="M10.5 1.75V5h3.25M2.75 5.25v7.5c0 .83.67 1.5 1.5 1.5h5.5"/>',
  // Permission modes: accept edits (page + check), plan (clipboard with lines), bypass (shield struck through)
  'file-check': `<path d="${PAGE}"/><path d="M9 1.75V6h4.25M5.75 10l1.5 1.5 3-3"/>`,
  clipboard:
    '<path d="M5.75 3h-1C3.78 3 3 3.78 3 4.75v7.75c0 .97.78 1.75 1.75 1.75h6.5c.97 0 1.75-.78 1.75-1.75V4.75C13 3.78 12.22 3 11.25 3h-1"/><rect x="5.75" y="1.75" width="4.5" height="2.5" rx="1"/><path d="M5.75 7.5h4.5M5.75 10h4.5M5.75 12.5h2.25"/>',
  'shield-off': '<path d="M8 1.75l5.25 2v3.75c0 3.05-2.2 5.6-5.25 6.75-3.05-1.15-5.25-3.7-5.25-6.75V3.75L8 1.75z"/><path d="M2.25 2.25l11.5 11.5"/>',
  'triangle-alert': '<path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5l5.5-9.75z"/><path d="M8 6.25v3M8 11.5h.01"/>',
  // Diff pane: page with plus and minus; revert: arrow turning back
  'file-diff': `<path d="${PAGE}"/><path d="M9 1.75V6h4.25M8 6.75v3M6.5 8.25h3M6.5 11.5h3"/>`,
  undo: '<path d="M3.75 6.25h6.25a3.25 3.25 0 0 1 0 6.5H7.25M6.5 3.5L3.75 6.25 6.5 9"/>',
  // Attachments: a paperclip (three wires, drawn upright and turned 45°) and a picture (frame, sun, hill)
  paperclip: '<path transform="rotate(45 8 8)" d="M10.5 4.25V11a2.5 2.5 0 0 1-5 0V3.75a1.25 1.25 0 0 1 2.5 0v6.5"/>',
  image: '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><circle cx="5.75" cy="6.5" r="1.25"/><path d="M14 10.25l-2.6-2.6a1 1 0 0 0-1.4 0L4.5 13.25"/>',
  // MCP servers: a plug (two prongs, rounded body, cable); compaction: arrows folding onto a dashed line
  plug: '<path d="M6 1.75V5M10 1.75V5M3.75 5h8.5v2.5a3.25 3.25 0 0 1-3.25 3.25h-2a3.25 3.25 0 0 1-3.25-3.25V5zM8 10.75v3.5"/>',
  fold: '<path d="M8 1.5v3.75M10 3.25l-2 2-2-2M8 14.5v-3.75M10 12.75l-2-2-2 2M1.5 8h1.25M5.5 8h1.25M9.25 8h1.25M13.25 8h1.25"/>',
  // Rewind: the refresh arrow turned the other way (counter-clockwise)
  'rotate-ccw': '<path d="M2.75 8A5.25 5.25 0 1 0 8 2.75c-1.4 0-2.75.55-3.75 1.5l-1.5 1.5M2.75 2.5v3.25H6"/>',
  // Task list: the header (two ticked lines), and the row glyphs: pending (empty circle), in progress while idle
  // (a filled arrow), completed (circle with a tick)
  'list-checks': '<path d="M2.25 4.25l1.25 1.25 2.25-2.5M2.25 10.75L3.5 12l2.25-2.5M8.5 4.25h5.25M8.5 10.75h5.25"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  'arrow-filled': '<path d="M5.75 4.25v7.5L11.75 8z" fill="currentColor"/>',
  'circle-check': '<circle cx="8" cy="8" r="6"/><path d="M5.5 8.25l1.75 1.75 3.25-3.5"/>',
  // Setup strip: the model server (two stacked units with their lights) and a download (arrow into a tray)
  server: `<rect x="2.25" y="2.5" width="11.5" height="4.75" rx="1.25"/><rect x="2.25" y="8.75" width="11.5" height="4.75" rx="1.25"/>${dot(4.75, 4.875, 0.8)}${dot(4.75, 11.125, 0.8)}`,
  download: '<path d="M8 2.25v8M4.75 7L8 10.25 11.25 7M2.75 11.25v1c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5v-1"/>',
  // sidebar
  // Navigation rows: Scheduled (a clock), Customize (two sliders); row glyphs: a sub-session (an arrow turning into
  // an indented line), Merge (two branches joining); export (a page with an arrow out). Task card: to do (a dashed
  // circle), done (a filled circle with the tick cut out in the card's colour).
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>',
  sliders: `<path d="M2.5 5h4.25M10.25 5h3.25M2.5 11h1.75M7.75 11h5.75"/><circle cx="8.5" cy="5" r="1.75"/><circle cx="6" cy="11" r="1.75"/>`,
  'sub-session': '<path d="M4 2.5v5.25c0 1.1.9 2 2 2h6.5M10 7.25l2.5 2.5-2.5 2.5"/>',
  'git-merge': '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6M4.5 5.5c0 2 1.5 3.5 3.5 3.5h2"/>',
  'file-export': `<path d="${PAGE}"/><path d="M9 1.75V6h4.25M8 13V8.5M6 10.25L8 8.25l2 2"/>`,
  'circle-dashed': '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2.2"/>',
  // Dreaming: the navigation row and a dream's sessions (a crescent moon), and the run control (a play triangle)
  moon: '<path d="M13.25 9.75A5.75 5.75 0 1 1 6.25 2.75a4.75 4.75 0 0 0 7 7z"/>',
  play: '<path d="M5.25 3.5v9l7-4.5-7-4.5z"/>',
  'circle-check-filled': '<circle cx="8" cy="8" r="6.25" fill="currentColor" stroke="none"/><path d="M5.5 8.25l1.75 1.75 3.25-3.5" style="stroke: var(--task-check, #fff)"/>',
  // mods: the rail toggle (panel-left mirrored), icons a manifest may name (gauge, message, clock) and the default
  // for a mod without one (four blocks, one of them round)
  'panel-right': '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M9.75 2.75v10.5"/>',
  gauge: `<path d="M2.25 11.75a5.75 5.75 0 1 1 11.5 0"/><path d="M8 11.75l2.75-3.25"/>${dot(8, 11.75, 1.1)}`,
  message: '<path d="M4.25 2.75h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7.5l-3.25 2.5v-2.5c-.83 0-1.5-.67-1.5-1.5v-5.5c0-.83.67-1.5 1.5-1.5z"/>',
  blocks: '<rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.25"/><rect x="9" y="2.25" width="4.75" height="4.75" rx="1.25"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.25"/><circle cx="11.375" cy="11.375" r="2.375"/>',
  // settings
  // Settings navigation: a gauge (context), a puzzle piece (mods), a clock (scheduled), a phone (remote control),
  // an archive box (history), a palette (appearance); and the API key's "hide" eye
  puzzle:
    '<path d="M3 4.75c0-.41.34-.75.75-.75H6a1.25 1.25 0 1 1 2.5 0h2.25c.41 0 .75.34.75.75V7a1.25 1.25 0 1 1 0 2.5v2.75c0 .41-.34.75-.75.75H8.5a1.25 1.25 0 1 0-2.5 0H3.75a.75.75 0 0 1-.75-.75V9.5a1.25 1.25 0 1 0 0-2.5V4.75z"/>',
  smartphone: '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75"/><path d="M7.25 12h1.5"/>',
  archive: '<rect x="1.75" y="2.75" width="12.5" height="3.25" rx="1"/><path d="M2.75 6v6.25c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V6M6.5 8.75h3"/>',
  palette:
    '<path d="M8 1.75a6.25 6.25 0 0 0 0 12.5c.83 0 1.25-.5 1.25-1.13 0-.33-.13-.6-.32-.84-.2-.24-.33-.51-.33-.86 0-.69.56-1.17 1.25-1.17h1.4a3.5 3.5 0 0 0 3-3.5C14.25 4.16 11.45 1.75 8 1.75z"/>' +
    dot(5, 7, 0.9) + dot(7, 4.5, 0.9) + dot(10.25, 5, 0.9),
  'eye-off': '<path d="M6.3 3.95A6.4 6.4 0 0 1 8 3.75C12 3.75 14.25 8 14.25 8a11 11 0 0 1-1.6 2.15M4.2 4.95C2.6 6.1 1.75 8 1.75 8S4 12.25 8 12.25c1.1 0 2.05-.3 2.9-.8M6.6 6.6a2 2 0 0 0 2.8 2.8M2.25 2.25l11.5 11.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** SVG markup for an icon. Size is in CSS pixels; the drawing is always on the 16px grid. */
export function icon(name: IconName, size = 16, cls = ''): string {
  return `<svg class="icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

/** Replaces `data-icon="name"` (and optional `data-icon-size`) placeholders in static markup with SVGs. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon ?? '';
    if (!isIconName(name)) return;
    el.insertAdjacentHTML('afterbegin', icon(name, Number(el.dataset.iconSize) || 16));
    delete el.dataset.icon;
    delete el.dataset.iconSize;
  });
}

// The Silo Harness S on build/icon.svg's 9x12 LED board: the top half, and the bottom half is it turned 180 degrees.
const S_TOP = ['.#######.', '#########', '###...###', '###......', '###......', '########.'];
const S_ROWS = [...S_TOP, ...S_TOP.slice().reverse().map((r) => [...r].reverse().join(''))];

/**
 * The Silo Harness mark: the S in --mark-ink on a tile in --mark. From 32 px it is build/icon.svg's LED board (lit dots
 * that vary a little in size and brightness, unlit dots faint); below that the dots only blur, so it is a solid S of cells.
 */
export function brandMark(size = 40): string {
  const p = 2.2, x0 = 20 - (9 * p) / 2, y0 = 20 - (12 * p) / 2;
  let s = '';
  if (size >= 32) {
    S_ROWS.forEach((row, r) => [...row].forEach((ch, c) => {
      const cx = (x0 + (c + 0.5) * p).toFixed(2), cy = (y0 + (r + 0.5) * p).toFixed(2);
      if (ch !== '#') { s += `<circle cx="${cx}" cy="${cy}" r="0.4" fill-opacity="0.22"/>`; return; }
      const t = (c / 8 + r / 11) / 2, wobble = ((c * 7 + r * 13) % 5) / 4 - 0.5;
      const rad = p * (0.5 - 0.07 * Math.abs(t - 0.5) * 2 + 0.03 * wobble);
      s += `<circle cx="${cx}" cy="${cy}" r="${rad.toFixed(2)}" fill-opacity="${(1 - 0.14 * t + 0.06 * wobble).toFixed(2)}"/>`;
    }));
  } else {
    S_ROWS.forEach((row, r) => {
      for (const m of row.matchAll(/#+/g)) s += `<rect x="${(x0 + (m.index ?? 0) * p).toFixed(2)}" y="${(y0 + r * p).toFixed(2)}" width="${(m[0].length * p).toFixed(2)}" height="${p}"/>`;
    });
  }
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="var(--mark)"/><g fill="var(--mark-ink)">${s}</g></svg>`;
}
