// What the agent gets for writing mods: the mod_check tool, a short system-prompt section, and the slash commands
// that enabled mods contribute.

import type { ModInfo, ModLayout } from '../../shared/mods';
import { hasFeatureParts, hasLookParts } from './manifest';
import type { CommandInfo, CommandResult } from '../../shared/types';
import type { Tool } from '../tools/types';
import type { ModRegistry } from './registry';

const RUNTIME_SHOWN = 5;

const TAB_OF = { background: 'Background', composer: 'Chat bar', conversation: 'Conversation' } as const;

/** The tabs of Settings → Mods where a mod's looks are chosen ("Background, Chat bar") */
function lookTabs(m: ModInfo): string {
  const c = m.manifest?.contributes ?? {};
  const tabs: string[] = [];
  if ((c.views ?? []).some((v) => v.seat === 'background')) tabs.push(TAB_OF.background);
  if ((c.looks ?? []).some((l) => l.target === 'composer')) tabs.push(TAB_OF.composer);
  if ((c.looks ?? []).some((l) => l.target === 'conversation')) tabs.push(TAB_OF.conversation);
  return tabs.join(', ');
}

/** `layout`: what is in use ("<mod key>/<look id>" per region, the background), so a look can say whether it is the active one. */
function describeMod(m: ModInfo, layout?: Partial<ModLayout>): string {
  const chosen = layout?.looks as Record<string, string | null> | undefined;
  const lines: string[] = [];
  const name = m.manifest ? `${m.manifest.name} (${m.id} ${m.manifest.version})` : m.id;
  lines.push(`## ${name}`);
  lines.push(`Folder: ${m.dir}`);
  lines.push(`Scope: ${m.scope}${m.overrides ? ' (replaces the bundled mod with this id)' : ''} · key: ${m.key} · origin: ${m.origin}/`);
  const looksOnly = !!m.manifest && hasLookParts(m.manifest) && !hasFeatureParts(m.manifest);
  lines.push(`State: ${m.state}${looksOnly ? ' (only looks, so no switch: on while one of them is in use)' : ''}`);
  if (m.manifest && hasLookParts(m.manifest)) {
    lines.push(`Looks in use: ${m.inUse?.length ? m.inUse.map((k) => TAB_OF[k]).join(', ') : 'none'} · approved for use: ${m.approved ? 'yes' : m.scope === 'bundled' ? 'yes (bundled)' : 'not yet (the first Use asks the user)'}`);
  }
  const manifestProblems = m.problems.filter((p) => p.kind !== 'runtime' && !p.warning);
  const warnings = m.problems.filter((p) => p.warning);
  const runtime = m.problems.filter((p) => p.kind === 'runtime');
  if (manifestProblems.length) {
    lines.push(`Problems in mod.json (${manifestProblems.length}):`);
    for (const p of manifestProblems) lines.push(`- ${p.message}`);
    if (m.manifest) lines.push('(The last valid version of mod.json is still in use until these are fixed.)');
  } else lines.push('mod.json: valid');
  if (warnings.length) {
    lines.push(`Warnings in mod.json (${warnings.length}; the rest of the mod loads):`);
    for (const p of warnings) lines.push(`- ${p.message}`);
  }
  lines.push(`Permissions granted: ${m.granted.join(', ') || 'none'}`);
  if (m.wants.length) lines.push(`Permissions asked for and not granted: ${m.wants.join(', ')}`);
  if (m.wantsStyles) lines.push('Contributes looks or a background that the user has not approved yet (they approve them at the first Use).');
  const views = m.manifest?.contributes?.views ?? [];
  if (views.length) {
    lines.push('Views:');
    for (const v of views) lines.push(`- ${v.id}: "${v.title}" in the ${v.seat} seat, page ${v.entry}`);
  } else lines.push('Views: none');
  const looks = m.manifest?.contributes?.looks ?? [];
  if (looks.length) {
    lines.push('Looks (scoped to their region; the user picks one per region in Settings → Mods → Chat bar or Conversation):');
    for (const l of looks) lines.push(`- ${l.id}: "${l.title}" for the ${l.target === 'composer' ? 'chat bar (@scope #chatbar)' : 'conversation (@scope #messages)'}, ${l.styles.join(', ')}${chosen?.[l.target] === `${m.key}/${l.id}` ? ' · active' : ''}`);
  }
  if (m.manifest?.contributes?.commands?.length) lines.push(`Commands: ${m.manifest.contributes.commands.map((c) => `/${c.name}`).join(', ')}`);
  if (runtime.length) {
    lines.push(`Errors its pages reported (latest ${Math.min(RUNTIME_SHOWN, runtime.length)} of ${runtime.length}):`);
    for (const p of runtime.slice(-RUNTIME_SHOWN)) lines.push(`- ${p.view ? `[${p.view}] ` : ''}${p.message}`);
  } else if (m.state === 'on') lines.push('Errors its pages reported: none');
  if (layout?.background && views.some((v) => layout.background === `${m.key}/${v.id}`)) lines.push(`Background in use: ${layout.background}`);
  lines.push(`Next: ${nextStep(m, manifestProblems.length, runtime.length, looksOnly)}`);
  return lines.join('\n');
}

function nextStep(m: ModInfo, problems: number, runtime: number, looksOnly: boolean): string {
  if (m.state === 'invalid') return 'Fix the problems above in mod.json, then call mod_check again. Nothing of the mod loads until it validates.';
  if (problems) return 'Fix the problems above in mod.json, then call mod_check again.';
  if (looksOnly && m.state === 'off')
    return `The look is written. Nothing turns it on: the user previews it and uses it from the card in the chat (Preview, Use) or in Settings → Mods → ${lookTabs(m)}, where it shows in a preview first. Tell them so; do not try to apply it yourself. Its files reload in the preview as you save them.`;
  if (m.state === 'off') return 'The mod is written but off: the user turns it on from the card in the chat or in Settings → Mods. Tell them so; do not try to turn it on yourself.';
  if (m.state === 'paused')
    return looksOnly
      ? `The look is in use but stopped applying, because it now asks for more than the user approved (${m.wants.join(', ')}). The user approves the change from the card in the chat or with Use in Settings → Mods → ${lookTabs(m)}.`
      : `The mod is paused because it now asks for more than the user approved (${m.wants.join(', ')}). The user approves the change from the card in the chat or in Settings → Mods.`;
  if (runtime) return 'Fix the errors above in the page; it reloads when you save. Then call mod_check again (errors from before the fix stay listed until the app restarts, so compare the times).';
  if (looksOnly) return 'The look is in use and healthy. It reloads as you save it.';
  return 'The mod is on and healthy. Pages reload as you save them.';
}

/**
 * The text mod_check returns: one mod by id, or every mod that is not bundled. `layout` says what is in use (the look
 * per region, the background), so a look can say whether it is the active one.
 */
export function modCheckText(registry: ModRegistry, id?: string, layout?: Partial<ModLayout>): string {
  const describe = (m: ModInfo) => describeMod(m, layout);
  const all = registry.scan();
  const roots = registry.roots();
  const where = roots.filter((r) => r.scope !== 'bundled').map((r) => `${r.scope}: ${r.dir}/<id>/`).join('; ');
  if (id) {
    const found = all.filter((m) => m.id === id || m.key === id);
    if (!found.length) return `No mod with the id "${id}". Mods are folders named by their id containing a mod.json (${where}). Write the folder, then call mod_check again.`;
    return found.map(describe).join('\n\n');
  }
  const mine = all.filter((m) => m.scope !== 'bundled');
  if (!mine.length) return `No user or project mods yet. Write one in ${where} (load the create-mod skill first).`;
  return mine.map(describe).join('\n\n');
}

export function modCheckTool(registry: ModRegistry, layout?: () => Partial<ModLayout>): Tool & { readOnly: true } {
  return {
    name: 'mod_check',
    description:
      'Check a Silo Harness mod after writing or editing it: where it is, whether it is on, problems in its mod.json, its permissions and views, and the errors its pages threw. Call it after every change to a mod. Without an id it checks every user and project mod.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The mod id (its folder name); omit to check all of them' } },
    },
    readOnly: true,
    async run(args) {
      const id = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
      return { content: modCheckText(registry, id, layout?.()) };
    },
  };
}

/** The system-prompt section: what mods are, the skill to load first, and the installed ones. */
export function modsPrompt(list: ModInfo[]): string {
  const named = list.filter((m) => m.manifest).slice(0, 30).map((m) => `${m.id} (${m.scope}, ${m.state})`);
  return [
    'Mods: the user can extend Silo Harness with mods (folders with a mod.json and HTML: panels, tabs, looks, slash commands and more).',
    'Before writing or changing a mod, load the create-mod skill with the skill tool, and check every change with the mod_check tool.',
    `Installed mods: ${named.length ? named.join(', ') : 'none'}.`,
  ].join('\n');
}

type RegisterCommand = (cmd: CommandInfo & { run(args: string, ctx: { sessionId: string }): CommandResult | Promise<CommandResult> }) => () => void;

/** Keeps app.commands in step with the commands of the mods that are on. */
export class ModCommands {
  private disposers: (() => void)[] = [];
  private signature = '';

  constructor(
    private readonly register: RegisterCommand,
    private readonly fire: (mod: string, data: { name: string; args: string; view?: string }) => void,
  ) {}

  /** Re-registers when the set of commands changed; returns the names registered */
  sync(list: ModInfo[]): string[] {
    const cmds: { key: string; name: string; description: string; view?: string }[] = [];
    const seen = new Set<string>();
    for (const m of list) {
      if (m.state !== 'on') continue;
      for (const c of m.manifest?.contributes?.commands ?? []) {
        if (seen.has(c.name)) continue; // two mods with one name: the first (bundled, then user, then project) wins
        seen.add(c.name);
        cmds.push({ key: m.key, name: c.name, description: c.description, view: c.view });
      }
    }
    const sig = JSON.stringify(cmds);
    if (sig === this.signature) return cmds.map((c) => c.name);
    this.signature = sig;
    this.dispose();
    for (const c of cmds) {
      this.disposers.push(
        this.register({
          name: c.name,
          description: c.description,
          source: 'mod',
          run: (args) => {
            this.fire(c.key, { name: c.name, args: String(args ?? ''), ...(c.view ? { view: c.view } : {}) });
            return {};
          },
        }),
      );
    }
    return cmds.map((c) => c.name);
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {
        /* already gone */
      }
    }
  }
}
