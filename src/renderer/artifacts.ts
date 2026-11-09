// Artifact card: a deliverable the model made with create_artifact (a page, a document, an image or code), drawn as
// the compact file card (file-card.ts): the tile, the title and "Artifact · HTML". A click opens it in the Browser
// pane; Save as… and Reveal in Finder are the small buttons at its right. Updates to the same artifact refresh the
// card, with an "Updated" chip.

import type { ArtifactInfo, ArtifactKind } from '../shared/types';
import { formatBytes } from './dom.js';
import { createFileCard, type FileCardParts } from './file-card.js';
import type { IconName } from './icons.js';

export interface ArtifactCard {
  el: HTMLElement;
  info: ArtifactInfo;
  /** A newer version of the same artifact: refreshes the title and meta line; `updated` shows the "Updated" chip */
  update(info: ArtifactInfo, updated?: boolean): void;
}

export type ArtifactAction = 'open' | 'saveAs' | 'reveal';

export interface ArtifactCardOptions {
  /**
   * Runs a button's action. Resolves to a short confirmation to flash on the button ("Saved"), true when done
   * without one, or false when it failed or was cancelled (the caller reports errors next to the button).
   */
  act: (card: ArtifactCard, action: ArtifactAction, button: HTMLButtonElement) => Promise<string | boolean>;
  /** Show the "Updated" chip from the start */
  updated?: boolean;
}

const LANGUAGES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby', go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', md: 'Markdown', markdown: 'Markdown', xml: 'XML',
  c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
  swift: 'Swift', php: 'PHP', lua: 'Lua', r: 'R', dart: 'Dart', scala: 'Scala', hs: 'Haskell', haskell: 'Haskell',
};

/** "HTML", "Markdown", "SVG", or the code's language ("Python", "TypeScript", …; "Code" when none is given) */
export function artifactKindLabel(info: { kind?: ArtifactKind | string; language?: string }): string {
  switch (info.kind) {
    case 'html': return 'HTML';
    case 'markdown': return 'Markdown';
    case 'svg': return 'SVG';
    default: {
      const lang = typeof info.language === 'string' ? info.language.trim() : '';
      if (!lang) return 'Code';
      return LANGUAGES[lang.toLowerCase()] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
    }
  }
}

export function artifactIcon(kind: ArtifactKind | string | undefined): IconName {
  return kind === 'html' ? 'globe' : kind === 'markdown' ? 'note' : kind === 'svg' ? 'image' : 'code';
}

/** "HTML · v2 · 4 KB" */
export function artifactMeta(info: ArtifactInfo): string {
  const parts = [artifactKindLabel(info)];
  const version = Math.floor(Number(info.version));
  if (version > 0) parts.push(`v${version}`);
  if (Number.isFinite(Number(info.bytes)) && Number(info.bytes) >= 0) parts.push(formatBytes(Number(info.bytes)));
  return parts.join(' · ');
}

/** "Artifact · HTML", "Artifact · MD", "Artifact · Python" */
export function artifactCardMeta(info: Pick<ArtifactInfo, 'kind' | 'language'>): string {
  return `Artifact · ${info.kind === 'markdown' ? 'MD' : artifactKindLabel(info)}`;
}

const ACTIONS: readonly [ArtifactAction, IconName, string][] = [
  ['reveal', 'folder', 'Reveal in Finder'],
  ['saveAs', 'download', 'Save as…'],
];

export function createArtifactCard(info: ArtifactInfo, opts: ArtifactCardOptions): ArtifactCard {
  let parts: FileCardParts;
  let flashTimer: number | undefined;
  const card: ArtifactCard = {
    el: null as unknown as HTMLElement,
    info,
    update(next: ArtifactInfo, updated = false) {
      if (!next || next.id !== card.info.id) return;
      // An older copy (e.g. replayed from the transcript) never rolls the card back.
      if (Number(next.version) < Number(card.info.version)) return;
      card.info = { ...card.info, ...next };
      render();
      if (updated) {
        parts.setChip('Updated');
        const el = card.el;
        el.classList.remove('flash');
        void el.offsetWidth; // restart the highlight animation
        el.classList.add('flash');
        window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => el.classList.remove('flash'), 1200);
      }
    },
  };
  parts = createFileCard({
    className: 'artifact-card',
    title: info.title?.trim() || 'Untitled artifact',
    meta: artifactCardMeta(info),
    icon: artifactIcon(info.kind),
    open: (el) => opts.act(card, 'open', el as HTMLButtonElement).then(Boolean),
    actions: ACTIONS.map(([action, iconName, label]) => ({ id: action, icon: iconName, label, run: (btn: HTMLButtonElement) => opts.act(card, action, btn) })),
  });
  card.el = parts.el;

  function render(): void {
    const a = card.info;
    const el = card.el;
    el.dataset.artifactId = a.id;
    el.dataset.kind = a.kind;
    parts.setIcon(artifactIcon(a.kind));
    parts.setTitle(a.title?.trim() || 'Untitled artifact');
    parts.setMeta(artifactCardMeta(a));
    // The longer line the card had (the version and the size) and where the file is, on hover
    el.title = [artifactMeta(a), a.path].filter(Boolean).join('\n');
  }

  render();
  if (opts.updated) parts.setChip('Updated');
  return card;
}
