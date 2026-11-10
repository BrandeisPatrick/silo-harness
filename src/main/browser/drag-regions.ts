// A web page in the pane may not drag the window. The app's window hides its title bar, so Electron reads a page's
// -webkit-app-region: drag (Teams' loading splash marks its whole viewport) as a window-drag area: a press there
// moves the window and never reaches the page. Electron keeps that region per web contents until a page sends a new
// one, so it also outlived the page and blocked every later page in the tab. A user style sheet in each document
// takes the property from every element, and the no-drag on :root makes each new document send its (empty) region.
//
// The behaviour is checked live: test/live/browser-drag-regions.js.

import type { WebContents } from 'electron';

const NO_DRAG_CSS = '*, ::before, ::after, ::backdrop { -webkit-app-region: initial !important; } :root { -webkit-app-region: no-drag !important; }';

/** Keeps every document `wc` shows from marking part of the window as a drag area. */
export function noPageDragRegions(wc: WebContents): void {
  wc.on('did-navigate', () => void wc.insertCSS(NO_DRAG_CSS, { cssOrigin: 'user' }).catch(() => undefined));
}
