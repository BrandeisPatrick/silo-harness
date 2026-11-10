// The update check's contract between the main process (src/main/updates.ts) and the window's quiet line. Types only.

/** A newer release than the running one, or null. `url` is its GitHub release page. */
export interface UpdateState {
  available: { version: string; url: string } | null;
}

export interface UpdatesRpc {
  'updates.state': () => UpdateState;
  /** Opens the release page in the default browser (the address comes from the main process, never the window) */
  'updates.open': () => void;
}

export interface UpdatesEvents {
  'updates:changed': UpdateState;
}
