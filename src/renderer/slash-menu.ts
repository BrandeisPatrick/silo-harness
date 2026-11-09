// The "/" menu above the composer: the skills and the commands that match what was typed, with the keyboard moving the
// selection and ↵/Tab inserting it. The window's own commands come first, then the app's registered ones (app.commands).

import type { CommandInfo, SkillInfo } from '../shared/types';
import { escapeHtml } from './dom.js';

export interface SlashMenuDeps {
  menu: HTMLElement;
  input: HTMLTextAreaElement;
  listSkills(): Promise<SkillInfo[]>;
  /** The commands registered in the main process (app.commands) */
  registeredCommands(): Promise<CommandInfo[]>;
  /** Only one menu at a time above the composer */
  closeMentions(): void;
  /** The composer grew or shrank with what was inserted */
  autosize(): void;
}

export interface SlashMenu {
  hideSlashMenu(): void;
  /** Shows the rows that match the composer's text (a "/" and a word), or hides the menu */
  updateSlashMenu(): Promise<void>;
  moveSlashSelection(delta: number): void;
  acceptSlashSelection(): void;
}

const BUILTINS: SkillInfo[] = [
  { name: 'skills', description: 'List skills', path: '', source: 'bundled' },
  { name: 'compact', description: 'Summarise the conversation', path: '', source: 'bundled' },
  { name: 'mcp', description: 'Show MCP servers', path: '', source: 'bundled' },
];
export function createSlashMenu({ menu: slashMenu, input: inputEl, listSkills, registeredCommands, closeMentions, autosize }: SlashMenuDeps): SlashMenu {
  let slashItems: SkillInfo[] = [];
  let slashIndex = 0;

  function hideSlashMenu(): void {
    slashMenu.hidden = true;
    slashMenu.innerHTML = '';
    slashItems = [];
  }

  async function updateSlashMenu(): Promise<void> {
    const value = inputEl.value;
    const m = /^\/([\w-]*)$/.exec(value);
    if (!m) return hideSlashMenu();
    const prefix = m[1].toLowerCase();
    const [allSkills, registered] = await Promise.all([listSkills(), registeredCommands()]);
    const skills = allSkills.filter((sk) => sk.name.toLowerCase().startsWith(prefix));
    if (inputEl.value !== value) return;
    // The window's own commands first, then the app's registered ones (app.commands), tagged with where they come from.
    const extra: SkillInfo[] = registered
      .filter((c) => c.name.toLowerCase().startsWith(prefix) && !BUILTINS.some((b) => b.name === c.name))
      .map((c) => ({ name: c.name, description: c.argsHint ? `${c.argsHint} · ${c.description}` : c.description, path: '', source: c.source === 'mod' ? 'user' : 'bundled', tag: c.source === 'mod' ? 'mod' : 'command' }) as SkillInfo & { tag: string });
    const commands = [...BUILTINS.filter((sk) => sk.name.startsWith(prefix)), ...extra];
    slashItems = [...skills, ...commands];
    if (!slashItems.length) return hideSlashMenu();
    slashIndex = 0;
    slashMenu.innerHTML = '';
    const scroll = document.createElement('div');
    scroll.className = 'slash-scroll';
    const section = (label: string, list: SkillInfo[], offset: number, builtin: boolean) => {
      if (!list.length) return;
      scroll.insertAdjacentHTML('beforeend', `<div class="slash-label">${label}</div>`);
      list.forEach((sk, k) => {
        const i = offset + k;
        const row = document.createElement('div');
        row.className = 'slash-item' + (i === slashIndex ? ' active' : '');
        row.setAttribute('role', 'option');
        const tag = (sk as SkillInfo & { tag?: string }).tag;
        row.innerHTML = `<span class="name">/${escapeHtml(sk.name)}</span><span class="desc">${escapeHtml(sk.description)}</span><span class="src">${tag ? escapeHtml(tag) : builtin ? 'command' : escapeHtml(sk.source)}</span>`;
        row.onmousedown = (e) => {
          e.preventDefault();
          slashIndex = i;
          acceptSlashSelection();
        };
        row.onmousemove = () => {
          if (slashIndex !== i) {
            slashIndex = i;
            highlightSlash();
          }
        };
        scroll.appendChild(row);
      });
    };
    section('Skills', skills, 0, false);
    section('Commands', commands, skills.length, true);
    slashMenu.appendChild(scroll);
    slashMenu.insertAdjacentHTML('beforeend', '<div class="slash-foot"><span><kbd>↵</kbd><kbd>tab</kbd> insert</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></div>');
    closeMentions();
    slashMenu.hidden = false;
  }

  function highlightSlash(): void {
    slashMenu.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('active', i === slashIndex));
    slashMenu.querySelectorAll('.slash-item')[slashIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function moveSlashSelection(delta: number): void {
    if (!slashItems.length) return;
    slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
    highlightSlash();
  }

  function acceptSlashSelection(): void {
    const sk = slashItems[slashIndex];
    if (!sk) return;
    inputEl.value = `/${sk.name} `;
    hideSlashMenu();
    autosize();
    inputEl.focus();
  }

  return { hideSlashMenu, updateSlashMenu, moveSlashSelection, acceptSlashSelection };
}
