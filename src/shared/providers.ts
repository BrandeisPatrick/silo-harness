// The providers feature's contract with the window (src/main/providers-service.ts): the models a provider offers,
// choosing one, its effort, a quick test, and the command-line tool's row in Settings → General. Types only.

import type { EffortLevel } from './types';

export interface ProviderTestInfo {
  ok: boolean;
  name: string;
  label: string;
  model: string;
  /** How long the answer took */
  ms: number;
  /** ok: the first words of the reply */
  reply?: string;
  /** In plain words, never with the key */
  error?: string;
}

/** The `silo` command and its link on the PATH. */
export interface CliStatus {
  /** The command inside the app (Contents/Resources/bin/silo), or the checkout's bin/silo */
  command: string;
  /** The command exists at that path */
  available: boolean;
  /** Where the link goes: ~/.local/bin/silo */
  link: string;
  /** The link exists and points at `command` */
  installed: boolean;
  /** Something else is at the link's path (another file, or a link elsewhere) */
  conflict?: string;
  /** ~/.local/bin is on the PATH of a login shell */
  onPath: boolean;
}

export interface ProvidersRpc {
  /** The models a provider offers (its own list, then what the service lists); rejects with a plain reason */
  'providers.models': (name: string) => string[];
  /** Sets the model of a provider (any of them) and returns nothing; the window follows config:changed */
  'providers.setModel': (name: string, model: string) => void;
  /** Sets the reasoning effort of a named provider (null: none, the model's default); the window follows config:changed */
  'providers.setEffort': (name: string, level: EffortLevel | null) => void;
  /** One tiny chat completion through a provider (default: the one in use) */
  'providers.test': (name?: string) => ProviderTestInfo;
  'cli.status': () => CliStatus;
  /** Links ~/.local/bin/silo to the command (no administrator password needed) */
  'cli.install': () => CliStatus;
  'cli.uninstall': () => CliStatus;
}
