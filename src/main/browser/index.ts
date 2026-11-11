// The Browser pane's main-process code. A controller owns one session's tabs and does what that session's browser_*
// tools ask of its active one (session-tabs.ts keeps one per session); the rest of the folder is the pieces it is
// made of (see docs/architecture.md).
export { BrowserController, MAX_TABS } from './controller';
export { openChatLink, setupBrowser } from './feature';
export { NO_TABS, SessionTabs } from './session-tabs';
export { browserSession, BROWSER_PARTITION } from './session';
export { zoomMenuItems } from './zoom';
