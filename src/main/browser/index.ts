// The Browser pane's main-process code. The controller owns the tabs and does what the browser_* tools ask of the
// active one; the rest of the folder is the pieces it is made of (see docs/architecture.md).
export { BrowserController, MAX_TABS } from './controller';
export { openChatLink, setupBrowser } from './feature';
export { browserSession, BROWSER_PARTITION } from './session';
export { zoomMenuItems } from './zoom';
