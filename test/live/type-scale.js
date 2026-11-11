// Live check of the type scale and the spacing in the real window: computed sizes and the key geometry of the
// transcript, the sidebar, the rail, the chat bar and Settings, a mod page through harness.css, and that no visible
// text in the window is smaller than 12 px.
// Run: npm run build && node test/live/type-scale.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-type-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const near = (a, b, d = 1) => typeof a === 'number' && Math.abs(a - b) <= d;

/** Sessions in two date groups, so the sidebar has labels to measure */
function seedSessions(profile, cwd) {
  const dir = path.join(profile, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const day = 86_400_000;
  const mk = (title, at) => {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, title, createdAt: at, updatedAt: at, titleLocked: true, cwd, messages: [{ role: 'user', content: title }, { role: 'assistant', content: 'Done.' }] }));
  };
  mk('Fix the flaky webhook retry test', now - 60_000);
  mk('Bump Node to 22 in CI', now - 120_000);
  mk('Move config to environment variables', now - 3 * day);
  mk('Paginate the orders endpoint', now - 3 * day - 3_600_000);
}

/** Every visible element with text of its own under 12 px, with what it is */
const SMALL_TEXT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || el.closest('svg')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), id: el.id, fs, text: el.textContent.trim().slice(0, 30) });
  }
  return out;
})()`;
/** Keyboard-key glyphs keep their own size (11 px in an 18 px key); the terminal keeps its own. */
const allowed = (e) => e.tag === 'kbd' || /xterm/.test(e.cls);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-type-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-type-project-'));
  seedSessions(profile, project);
  const app = await launch({ profile, project, mode: 'auto', config: { theme: 'light' } });
  try {
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.hello).length >= 5`, 20_000, 'the rail to start').catch(() => {});
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');
    await app.evaluate(`(() => { const b = document.querySelector('#rail-toggle'); if (b && !b.hidden && b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
    // A conversation on screen without the model: a bubble, a reply with a heading, a list and code, tool lines, a task card
    await app.evaluate(`(() => {
      const d = window.__oc_debug;
      d.user('Make the retry backoff configurable and fix the flaky login test.');
      const e = d.emit;
      // Thinking, then two calls: the calls fold into one line (Tool activity: Summary), so there are two lines in a row
      e({ type: 'thinking_delta', text: 'The retry waits a fixed delay; the options should carry it.' });
      e({ type: 'thinking_done' });
      e({ type: 'tool_start', id: 't1', name: 'read_file', args: { path: 'src/auth/login.ts' } });
      e({ type: 'tool_end', id: 't1', name: 'read_file', result: 'line\\nline\\nline', ok: true, durationMs: 4 });
      e({ type: 'tool_start', id: 't2', name: 'bash', args: { command: 'npm test' } });
      e({ type: 'tool_end', id: 't2', name: 'bash', result: 'ok', ok: true, durationMs: 900 });
      d.renderMarkdown(${JSON.stringify(
        'The retry loop in `src/auth/login.ts` waits a fixed **3 seconds**; it takes the delay from the options now.\n\n' +
          '## What changes\n\n- `LoginOptions` gets `backoffMs` (default 500)\n- each retry waits `backoffMs * 2 ** attempt`\n- the test uses fake timers\n\n' +
          '```ts\nawait sleep(opts.backoffMs * 2 ** i);\n```\n\nAll five tests pass.',
      )});
      d.tasks([{ id: 'a', title: 'Make the backoff configurable', status: 'completed' }, { id: 'b', title: 'Fix the flaky test', status: 'in_progress' }, { id: 'c', title: 'Run the suite', status: 'pending' }]);
      d.context({ tokens: 23400, limit: 200000, threshold: 0.8, autoCompact: true });
    })()`);
    await sleep(800);
    await app.evaluate(`document.activeElement && document.activeElement.blur()`);
    await app.screenshot(path.join(SHOTS, 'window-light.png'));

    const m = await app.evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      const cs = (e) => getComputedStyle(e);
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, cy: r.y + r.height / 2 }; };
      const reply = [...document.querySelectorAll('#messages > .msg.assistant')].pop();
      const p = reply.querySelector('p');
      const code = reply.querySelector('p code');
      const h2 = reply.querySelector('h2');
      const lis = [...reply.querySelectorAll('li')];
      const tools = [...document.querySelectorAll('#messages > :is(.thinking, .tool, .tool-group)')];
      const bubble = q('#messages > .msg.user .bubble');
      const task = q('#task-list');
      const rows = [...document.querySelectorAll('.session-item')].filter((e) => e.offsetParent);
      const groups = [...document.querySelectorAll('.session-group')].filter((e) => e.offsetParent);
      const g2 = groups[1];
      const before = g2 && g2.previousElementSibling;
      const after = g2 && g2.nextElementSibling;
      const comp = q('#composer');
      const foot = q('#composer-foot');
      const plus = q('#attach-btn svg');
      const send = q('#send-btn svg');
      const ring = q('#context-meter svg');
      const codeRect = code.getClientRects()[0];
      return {
        body: { fs: cs(p).fontSize, lh: cs(p).lineHeight, inset: Math.round(box(p).x - box(reply).x), col: box(reply).w },
        bold: cs(reply.querySelector('strong')).fontWeight,
        h2: { fs: parseFloat(cs(h2).fontSize), fw: cs(h2).fontWeight },
        code: { fs: cs(code).fontSize, h: codeRect.height, pad: cs(code).paddingLeft, radius: cs(code).borderTopLeftRadius, border: cs(code).borderTopStyle },
        pre: { fs: cs(reply.querySelector('pre')).fontSize, lh: cs(reply.querySelector('pre')).lineHeight },
        liGap: lis.length > 1 ? Math.round(box(lis[1]).y - box(lis[0]).b) : null,
        tool: { lines: tools.map((t) => t.className.split(' ')[0]).join(','), fs: cs(tools[1].querySelector('summary')).fontSize, h: box(tools[1].querySelector('summary')).h, color: cs(tools[1].querySelector('summary')).color, muted: cs(document.documentElement).getPropertyValue('--text-400').trim(), border: cs(tools[1]).borderTopStyle, pitch: Math.round(box(tools[1]).y - box(tools[0]).y), gapAfter: Math.round(box(reply).y - box(tools[1]).b) },
        bubble: { fs: cs(bubble).fontSize, pad: cs(bubble).padding, radius: cs(bubble).borderTopLeftRadius },
        task: { w: box(task).w, radius: cs(task).borderTopLeftRadius, pad: cs(task).paddingTop, row: box(task.querySelector('.task-row')).h, fs: cs(task.querySelector('.task-row')).fontSize },
        topbar: box(q('.topbar')).h, titleFs: cs(q('#session-title')).fontSize, titleFw: cs(q('#session-title')).fontWeight,
        side: { fs: cs(rows[0]).fontSize, h: box(rows[0]).h, pitch: Math.round(box(rows[1]).y - box(rows[0]).y), radius: cs(rows[0]).borderTopLeftRadius, navFs: cs(q('.nav-row')).fontSize, navH: box(q('.nav-row')).h },
        group: g2 ? { fs: cs(g2).fontSize, above: Math.round(box(g2).cy - box(before).cy), below: Math.round(box(after).cy - box(g2).cy) } : null,
        rail: { fs: cs(q('.rail-head-btn')).fontSize, fw: cs(q('.rail-head-btn')).fontWeight, tt: cs(q('.rail-head-btn')).textTransform },
        bar: {
          h: box(comp).h, w: box(comp).w, radius: cs(comp).borderTopLeftRadius,
          oneRow: q('#attach-btn').parentElement === q('#input').parentElement && q('#send-btn').parentElement === q('#input').parentElement,
          cy: [box(q('#attach-btn')).cy, box(q('#input')).cy, box(q('#send-btn')).cy].map((v) => Math.round(v - box(comp).y)),
          plusIn: Math.round(box(plus).x - box(comp).x), plusW: box(plus).w, textIn: Math.round(box(q('#input')).x - box(comp).x), inputFs: cs(q('#input')).fontSize,
          sendOut: Math.round(box(comp).r - box(send).r),
          footOutside: !comp.contains(foot) && box(foot).y >= box(comp).b, footBelow: Math.round(box(foot).cy - box(comp).b),
          footFs: cs(q('#model-btn')).fontSize, footColor: (() => { const p = document.createElement('canvas').getContext('2d'); const rgb = (v) => { p.fillStyle = '#000'; p.fillStyle = v; return p.fillStyle; }; return rgb(cs(q('#model-btn')).color) === rgb(cs(document.documentElement).getPropertyValue('--text-400').trim()) ? cs(document.documentElement).getPropertyValue('--text-400').trim() : cs(q('#model-btn')).color; })(), ringOut: Math.round(box(comp).r - box(ring).r), ring: box(ring).w,
        },
      };
    })()`);
    check('reply text 15/21, bold 600', m.body.fs === '15px' && m.body.lh === '21px' && m.bold === '600', m.body);
    check('a heading in a reply is semibold and at most 17 px', m.h2.fs >= 15 && m.h2.fs <= 17 && Number(m.h2.fw) >= 600, m.h2);
    check('reading column: 736 px at most, running text inset 4 px', m.body.col <= 736 + 0.5 && m.body.inset === 4, m.body);
    check('inline code: 0.9em mono (13.5 px), an 18 px chip, 4.5 px side padding, 4 px radius, no border', m.code.fs === '13.5px' && near(m.code.h, 18, 1) && m.code.pad === '4.5px' && m.code.radius === '4px' && m.code.border === 'none', m.code);
    check('code blocks 13/20 mono', m.pre.fs === '13px' && m.pre.lh === '20px', m.pre);
    check('list items about 4 px apart', m.liGap !== null && m.liGap >= 3 && m.liGap <= 5, m.liGap);
    check('tool lines: 15 px, muted, a 24 px row, no box; 8 px between two, 16 px before the text', m.tool.lines === 'thinking,tool-group' && m.tool.fs === '15px' && m.tool.h === 24 && m.tool.border === 'none' && m.tool.pitch === 32 && m.tool.gapAfter === 16, m.tool);
    check('the user bubble: 15 px, 12/16 padding, 12 px radius', m.bubble.fs === '15px' && m.bubble.pad === '12px 16px' && m.bubble.radius === '12px', m.bubble);
    check('the task card: the column width, 10 px radius, 12 px padding, 28 px rows at 14 px', m.task.w <= 736.5 && m.task.radius === '10px' && m.task.pad === '12px' && near(m.task.row, 28) && m.task.fs === '14px', m.task);
    check('top bar 44 px plus its hairline; the title 14 px regular', m.topbar === 45 && m.titleFs === '14px' && m.titleFw === '400', { h: m.topbar, fs: m.titleFs, fw: m.titleFw });
    check('sidebar rows 14 px, 32 px tall on a 34 px pitch, 8 px radius; navigation rows the same', m.side.fs === '14px' && m.side.h === 32 && m.side.pitch === 34 && m.side.radius === '8px' && m.side.navFs === '14px' && m.side.navH === 32, m.side);
    check('date-group labels 12 px, 51 px below the row before and 35 px above the next', m.group && m.group.fs === '12px' && near(m.group.above, 51, 1) && near(m.group.below, 35, 1), m.group);
    check('rail headings 13 px, regular weight, not uppercase', m.rail.fs === '13px' && m.rail.fw === '400' && m.rail.tt === 'none', m.rail);
    check('chat bar: 46 px tall, 12 px radius, at most 770 px wide', m.bar.h === 46 && m.bar.radius === '12px' && m.bar.w <= 770.5, m.bar);
    check('chat bar: the plus, the field and the action in one row, centred on one line', m.bar.oneRow && m.bar.cy.every((v) => near(v, m.bar.cy[1], 1)), m.bar.cy);
    check('chat bar: a 14 px plus 16 px in, the text 45 px in at 15 px, the action glyph 15 px from the right edge', near(m.bar.plusIn, 16) && near(m.bar.plusW, 14, 0.5) && near(m.bar.textIn, 45) && m.bar.inputFs === '15px' && near(m.bar.sendOut, 15, 1.5), m.bar);
    check('chat bar: #composer-foot outside #composer, its row centred about 20 px below the bar, 12 px muted labels, a 12 px ring 14 px from the right edge', m.bar.footOutside && near(m.bar.footBelow, 20, 1) && m.bar.footFs === '12px' && m.bar.footColor === m.tool.muted && m.bar.ring === 12 && near(m.bar.ringOut, 14, 1), m.bar);

    // A mod page's row, through harness.css
    const envId = (await app.evaluate(`window.__oc_debug.mods.views().map((v) => v.key)`)).find((k) => k.startsWith('environment')) ? 'environment' : null;
    let mod = null;
    for (let i = 0; i < 20 && !mod; i++) {
      mod = await frameEvalPage(app, 'environment', `(() => { const r = document.querySelector('.info'); if (!r || !r.offsetHeight) return null; const s = getComputedStyle(r); return { fs: s.fontSize, lh: s.lineHeight, h: r.getBoundingClientRect().height, token: getComputedStyle(document.documentElement).getPropertyValue('--fs-ui').trim() }; })()`);
      if (!mod) await sleep(300);
    }
    check('a mod panel row is 14 px through harness.css, on a 32 px row, with the kit\'s --fs-ui', envId && mod && mod.fs === '14px' && mod.lh === '20px' && mod.h === 32 && mod.token === '14px', mod);

    const small = (await app.evaluate(SMALL_TEXT)).filter((e) => !allowed(e));
    check('no visible text in the window under 12 px (keyboard keys aside)', small.length === 0, small.slice(0, 8));

    // Settings
    await app.click('#settings-btn');
    await app.waitFor(`document.querySelector('#settings').open && document.querySelectorAll('.sp-row').length > 3`, 10_000, 'Settings');
    await sleep(600);
    await app.screenshot(path.join(SHOTS, 'settings-light.png'));
    const st = await app.evaluate(`(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      // Rows whose description is one line of text (not a path), and the row after each
      const rows = [...document.querySelectorAll('.sp-section.current .sp-row')].filter((e) => e.offsetParent);
      const i = rows.findIndex((r, k) => k > 0 && rows[k + 1] && r.querySelector('.sp-row-desc:not(.sp-path)') && r.querySelector('.sp-row-desc').getBoundingClientRect().height <= 21);
      const row = rows[i];
      const t = row.querySelector('.sp-row-title').getBoundingClientRect();
      const d = row.querySelector('.sp-row-desc').getBoundingClientRect();
      const nav = document.querySelector('.sp-nav-item').getBoundingClientRect();
      return {
        title: [cs('#settings-heading').fontSize, cs('#settings-heading').fontWeight],
        section: [cs('.sp-section.current .sp-title').fontSize, cs('.sp-section.current .sp-title').fontWeight],
        rowTitle: [getComputedStyle(row.querySelector('.sp-row-title')).fontSize, getComputedStyle(row.querySelector('.sp-row-title')).fontWeight], desc: getComputedStyle(row.querySelector('.sp-row-desc')).fontSize,
        pitch: Math.round(rows[i + 1].getBoundingClientRect().y - row.getBoundingClientRect().y), lines: Math.round(d.y - t.y), row: row.id,
        nav: [cs('.sp-nav-item').fontSize, nav.height],
      };
    })()`);
    check('Settings: the title and the section heading 15 px / 500', st.title[0] === '15px' && st.title[1] === '500' && st.section[0] === '15px' && st.section[1] === '500', st);
    check('Settings: row titles 14 px regular, descriptions 14 px, 24 px apart', st.rowTitle[0] === '14px' && st.rowTitle[1] === '400' && st.desc === '14px' && st.lines === 24, st);
    check('Settings: about 69 px from row to row (one-line descriptions), navigation rows 32 px at 14 px', near(st.pitch, 69, 1) && st.nav[0] === '14px' && st.nav[1] === 32, st);
    const smallSettings = (await app.evaluate(SMALL_TEXT)).filter((e) => !allowed(e));
    check('no visible text in Settings under 12 px', smallSettings.length === 0, smallSettings.slice(0, 8));
    await app.click('#settings-close');
    await sleep(300);

    // Dark: the same sizes
    await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'dark'; await window.oc.setConfig(c); })()`);
    await sleep(800);
    await app.screenshot(path.join(SHOTS, 'window-dark.png'));
    check('dark: the same scale', (await app.evaluate(`getComputedStyle(document.querySelector('#messages > .msg.assistant p')).fontSize`)) === '15px');
  } catch (err) {
    check('the run finished', false, String(err && err.stack));
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();

/** Evaluates in a mod frame whose URL contains `part` (mod frames are their own targets) */
async function frameEvalPage(app, part, expression) {
  const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
  const t = list.find((x) => x.type === 'iframe' && x.url.includes(part));
  if (!t || !t.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) resolve(msg.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    setTimeout(() => resolve(null), 4000);
  });
  ws.close();
  return res;
}
