// Settings → Developer → Reset: Reset settings… (the app's saved settings back to defaults; sessions stay) and Full
// reset… (the app back to its first launch). Each asks first, with Cancel as the default button, says what goes to
// the Trash and what is not touched, and then relaunches the app (src/main/reset.ts). Only this page can ask: the
// main window's own preload (window.oc.reset), never an RPC.

import type { SettingsInfo } from '../../shared/settings-info';
import type { Ctx } from './ctx.js';
import { button, row, type Row } from './ui.js';

/** What a full reset sends to the Trash, as the confirmation lists it */
export const FULL_RESET_ITEMS = ['Sessions and history', 'Logs', 'Browser data and sign-ins', 'Learned answers', 'Your mods', "The app's saved settings"];

export function resetRows(ctx: Ctx): Row[] {
  const relaunch = async (r: Row, btn: HTMLButtonElement, kind: 'full' | 'settings', settingsJson = false) => {
    btn.disabled = true;
    r.problem(null);
    try {
      await window.oc.reset(kind, { settingsJson });
      r.setDesc('Relaunching…');
    } catch (err) {
      r.problem(ctx.cleanError(err));
      btn.disabled = false;
    }
  };

  const settingsBtn = button('Reset…', async (b) => {
    const ok = await ctx.confirm({
      title: 'Reset settings?',
      description: "The app's saved settings go back to defaults and move to the Trash. Sessions, mods and your settings.json stay. The app relaunches.",
      confirmLabel: 'Reset and relaunch',
      danger: true,
    });
    if (ok) await relaunch(settingsRow, b, 'settings');
  }, { danger: true });
  const settingsRow = row({ id: 'reset-settings', title: 'Reset settings', desc: 'Back to defaults. Sessions stay.', keywords: 'reset settings defaults config.json preferences restore factory start over' }, settingsBtn);

  const fullBtn = button(
    'Reset…',
    async (b) => {
      // A linked settings.json (a dotfiles repo): only the link goes, the file it points to stays
      const info = (await ctx.call('settings.info').catch(() => null)) as SettingsInfo | null;
      const link = Boolean(info?.files?.some((f) => f.scope === 'user' && f.link));
      const checkbox = { label: link ? 'Also my settings.json (providers and keys): it is a link, so only the link goes; the file it points to stays' : 'Also my settings.json (providers and keys)', checked: false };
      const ok = await ctx.confirm({
        title: 'Full reset?',
        description: 'The app goes back to its first launch and relaunches. Your projects and their files are not touched. These move to the Trash:',
        items: FULL_RESET_ITEMS,
        checkbox,
        confirmLabel: 'Reset and relaunch',
        danger: true,
      });
      if (ok) await relaunch(fullRow, b, 'full', checkbox.checked);
    },
    { danger: true },
  );
  const fullRow = row({ id: 'reset-full', title: 'Full reset', desc: 'Back to the first launch.', keywords: 'full reset factory erase everything wipe start over first launch delete all data trash browser sign-ins logs learned answers' }, fullBtn);

  return [settingsRow, fullRow];
}
