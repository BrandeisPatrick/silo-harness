// What every section of the settings page gets from the page: the config and how to change it, the bridge (with
// the debug mock in front of it), the bound-field helpers and a few things that belong to the rest of the window.

import type { AppConfig } from '../../shared/types';
import type { RpcMethods } from '../../shared/rpc';
import type { ConfirmOptions } from '../changes.js';
import type { Choice, Row, RowOptions } from './ui.js';
import type { Parsed, SectionId } from './model.js';
import type { ModPreviews } from '../mods-host.js';

export type Call = <K extends keyof RpcMethods>(method: K, ...args: Parameters<RpcMethods[K]>) => Promise<Awaited<ReturnType<RpcMethods[K]>>>;

/** A section's content. load() fetches its data each time the page opens; 'absent' hides the section. */
export interface Section {
  id: SectionId;
  el: HTMLElement;
  load?(): Promise<'ok' | 'absent'>;
  /** The config changed (from this page or elsewhere) */
  sync?(config: AppConfig): void;
  /** The page closed */
  closed?(): void;
  /** A section with tabs of its own (Mods): the tab on screen, and bringing one on screen (with a look previewed there) */
  tab?(): string;
  showTab?(tab: string, opts?: { preview?: string }): void;
  /** Before the page reveals an element of the section (a search hit, an openSettings target): show the tab it is on */
  uncover?(el: HTMLElement): void;
}

export interface FieldOptions extends RowOptions {
  field: string;
}

export interface Ctx {
  config(): AppConfig;
  call: Call;
  /** True when the error says the method does not exist in this app (the feature is absent) */
  isUnknown(err: unknown): boolean;
  cleanError(err: unknown): string;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Writes one config field; shows the tick or the problem at the row. False when it was not saved. */
  save(row: Row, field: string, value: unknown): Promise<boolean>;
  /** Writes several fields at once (the same rules) */
  savePatch(row: Row, patch: Partial<AppConfig>): Promise<boolean>;
  /** The window's config copy follows a config the main process returned */
  adopt(next: AppConfig): void;

  switchField(opts: FieldOptions & { invert?: boolean }): Row;
  textField(opts: FieldOptions & { parse: (text: string) => Parsed<unknown>; format?: (v: unknown) => string; placeholder?: string; type?: 'text' | 'password' | 'number'; width?: number; mono?: boolean; inputId?: string; multiline?: boolean }): Row;
  selectField<T extends string | number>(opts: FieldOptions & { choices: Choice<T>[]; width?: number; read?: (v: unknown) => T; inputId?: string; onSaved?: (v: T) => void }): Row;
  segField<T extends string | number>(opts: FieldOptions & { choices: Choice<T>[]; read?: (v: unknown) => T; onSaved?: (v: T) => void }): Row;

  /** Brings a section on screen (clears the search), at one of its tabs, or at a row */
  show(id: SectionId, opts?: { row?: string; tab?: string }): void;
  /** Called by a section whose rows changed, so a running search sees them */
  refreshSearch(): void;

  /** Things that belong to the rest of the window */
  chooseFolder(): Promise<boolean>;
  openShortcuts(): void;
  currentSessionId(): string;
  /** Closes Settings and brings a session on screen */
  openSession(id: string): void;
  /** A session's title, when the window knows it */
  sessionTitle(id: string): string | undefined;
  /** Closes Settings and puts `text` in the composer, for the user to finish ("Make a chat bar look that …") */
  askAgent(text: string): void;
  /** Live previews of mod backgrounds, from the mod host (absent without one) */
  modPreviews?(): ModPreviews | null;
}
