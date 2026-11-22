// What the Settings page needs to know beyond the config itself: the settings.json files in play, which fields
// they own, and facts about the app. Types only.

/** One settings.json file. */
export interface SettingsFileInfo {
  scope: 'user' | 'project';
  /** Absolute path, whether or not the file exists */
  path: string;
  exists: boolean;
  /** It is a symbolic link (a write goes to the file it points to; a full reset moves the link only) */
  link?: true;
  /** Its values are in effect */
  applied: boolean;
  /** project scope: the user has agreed to this exact content. The user's own file is always trusted. */
  trusted: boolean;
  /** project scope: it was trusted, then edited; it is not applied until it is trusted again */
  changed?: boolean;
  /** It exists and could not be read as a JSON object */
  error?: string;
  /** What it sets: field paths ("portkey.model", "permissionMode") and "env.NAME" for each variable. Values are never included. */
  keys: string[];
  /** The commands and URLs its hooks run (the trust prompt says it runs commands) */
  hookCommands?: string[];
  /** Entries that were skipped, and why ("maxTurns: expected a number") */
  invalid: { key: string; message: string }[];
}

export interface SettingsInfo {
  files: SettingsFileInfo[];
  /** Field path → the file that sets it. The Settings page shows these fields as read-only. */
  owned: Record<string, 'user' | 'project'>;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  /** Where sessions, history and config.json live */
  userData: string;
  /** Where settings.json, skills and mods live */
  configDir: string;
}

export interface SettingsRpc {
  'settings.info': () => SettingsInfo;
  /** Applies (or stops applying) the project's settings.json as it is right now */
  'settings.trustProject': (trust: boolean) => SettingsInfo;
  /** Reads the files again */
  'settings.reload': () => SettingsInfo;
  /** Opens the file in the default editor, creating it with {} when it does not exist */
  'settings.open': (scope: 'user' | 'project') => void;
  'app.info': () => AppInfo;
  /** Shows a folder in Finder */
  'app.reveal': (which: 'userData' | 'configDir' | 'project' | 'skills') => void;
}

export interface SettingsEvents {
  /** The files or their trust changed; a 'config:changed' push carries the new effective config */
  'settings:changed': SettingsInfo;
}
