// Dreaming: a background session that reads what happened in recent sessions and proposes skills, mods and memory
// lines. The dream proposes; its mode decides when a proposal is applied, and the app (never the model) applies it.
// Types only (both builds compile this folder; the defaults and the tool names live in src/main/dreaming/names.ts,
// and the window keeps its own copy of the names in src/renderer/dreaming.ts).

/** auto: applied when proposed. approve: each waits for Apply or Dismiss. plan: gathered into one plan to approve. */
export type DreamMode = 'auto' | 'approve' | 'plan';

/** AppConfig.dreaming */
export interface DreamingConfig {
  /** Dream once a day at `time` (off until the user turns it on) */
  daily: boolean;
  /** "HH:MM", local time */
  time: string;
  mode: DreamMode;
  /** What to look for */
  skills: boolean;
  mods: boolean;
  memory: boolean;
}

export type ProposalKind = 'skill' | 'memory' | 'mod';
export type ProposalScope = 'project' | 'user';

/**
 * waiting: for Apply or Dismiss (approve mode). planned: part of the dream's plan (plan mode). applied, dismissed,
 * withdrawn (by the dream itself), reverted, failed (applying it did not work; `error` says why).
 */
export type ProposalState = 'waiting' | 'planned' | 'applied' | 'dismissed' | 'withdrawn' | 'reverted' | 'failed';

interface ProposalBase {
  id: string;
  dreamId: string;
  kind: ProposalKind;
  scope: ProposalScope;
  /** One line for lists and the card's heading */
  title: string;
  /** Why, in the dream's words, with the evidence quoted */
  why: string;
  /** The session ids it is based on */
  sessions: string[];
  state: ProposalState;
  createdAt: number;
  decidedAt?: number;
  error?: string;
  /** True when it changes something that exists (a skill, a mod, memory lines); the card shows the difference */
  changesExisting: boolean;
  /** The file or folder it writes (absolute) */
  target: string;
}

export interface SkillProposal extends ProposalBase {
  kind: 'skill';
  name: string;
  description: string;
  body: string;
  /** The SKILL.md as it will be written */
  content: string;
  /** What the file holds now, when it exists (for the difference) */
  current?: string;
}

export interface MemoryProposal extends ProposalBase {
  kind: 'memory';
  /** "SILOHARNESS.md", "~/.silo-harness/SILOHARNESS.md" */
  label: string;
  add: string[];
  remove: string[];
}

export interface ModProposal extends ProposalBase {
  kind: 'mod';
  modId: string;
  name: string;
  description: string;
  files: { path: string; content: string }[];
  /** The files the folder holds now, by relative path, when it exists */
  current?: Record<string, string>;
}

export type DreamProposal = SkillProposal | MemoryProposal | ModProposal;

/** How a dream was started */
export type DreamTrigger = 'daily' | 'manual' | 'command';

export interface Dream {
  id: string;
  sessionId: string;
  /** The project folder it read */
  cwd: string;
  trigger: DreamTrigger;
  mode: DreamMode;
  startedAt: number;
  endedAt?: number;
  /** running; done (its review ended); failed (`error`); stopped (by the user, or the app closed during it) */
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string;
  /** What the digest covered: turns and sessions, and how many turns were left for the next dream */
  covered: { sessions: number; turns: number; left: number; from: number; to: number };
  proposals: DreamProposal[];
  /** Plan mode: the plan on the session that gathers the proposals */
  planId?: string;
  /** The start of the dream's closing report (its last reply when its review ended) */
  summary?: string;
}

/** A project folder as Dreaming sees it: the folders of the sessions, for the Dreaming page and its Run a dream menu. */
export interface DreamProject {
  cwd: string;
  /** Sessions with turns no dream of the project has read yet */
  fresh: number;
  /** The newest activity in a session of the project, unix ms */
  lastActivity: number;
  /** The next dream (the daily one, or Run a dream for every project) reads it: it has turns no dream has read yet */
  next: boolean;
}

export interface DreamingState {
  config: DreamingConfig;
  /** The dream run in progress: the dream now running and how many projects wait behind it */
  running: { dreamId: string; sessionId: string; cwd: string; queued: number } | null;
  /** Unix ms of the next daily dream, null when daily dreaming is off */
  nextRunAt: number | null;
  /** The last time a run looked for something to dream about, and what it found */
  lastCheck?: { at: number; trigger: DreamTrigger; found: number };
  /** Proposals waiting for the user across all dreams (waiting, or in an undecided plan) */
  waiting: number;
  /** Newest first */
  dreams: Dream[];
}

export interface DreamingRpc {
  'dreaming.get': () => DreamingState;
  'dreaming.set': (patch: Partial<DreamingConfig>) => DreamingState;
  /** Starts a run by hand over the projects with new activity (or `cwd` alone); refused while one runs */
  'dreaming.run': (cwd?: string) => DreamingState;
  'dreaming.stop': () => DreamingState;
  'dreaming.list': () => Dream[];
  /** The project folders of the sessions (not dreams), most recently active first */
  'dreaming.projects': () => DreamProject[];
  'dreaming.apply': (proposalId: string) => Dream;
  'dreaming.dismiss': (proposalId: string) => Dream;
  /** Applies every proposal of the dream that waits (or is planned) */
  'dreaming.applyAll': (dreamId: string) => Dream;
  'dreaming.revert': (proposalId: string) => Dream;
}

export interface DreamingEvents {
  'dreaming:changed': DreamingState;
}
