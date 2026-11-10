// The scripts the controller runs inside pages: the outline with refs that browser_read_page returns, the element
// lookups and the hit test behind browser_click and browser_type, the flash on an element the agent is about to
// touch, the page's text, and the polling behind browser_wait_for. Every one runs in the safety world (see
// safety.ts): the page can neither see the refs nor replace the DOM methods these scripts call, and a credential
// field's value never comes back.

import { inSafetyWorld, maskedState } from './safety';

/** Refs look like ref_12; the safety world keeps which element each one names (S.addRef, S.byRef). */
export const REF_RE = /^ref_\d+$/;

/**
 * Runs inside the page (in the safety world): labels visible interactive elements with ref ids and returns a
 * compact outline. A credential field's value is never in it: its line ends = "•••" or (empty).
 */
export function readPageScript(mode: 'interactive' | 'all', maxChars: number): string {
  return inSafetyWorld(`
    const MODE = ${JSON.stringify(mode)};
    const MAX = ${maxChars};
    S.resetRefs();
    if (!document.body) return { text: '(empty page)', count: 0, truncated: false };
    const INTERACTIVE = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="textbox"],[role="combobox"],[role="option"],[role="switch"],[contenteditable="true"]';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const clean = S.clean;
    const label = (el, secret) => clean(
      el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (secret ? '' : ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : '') || el.innerText || el.textContent)
    ).slice(0, 120);
    const lines = []; let n = 0; let size = 0;
    const push = (line) => { lines.push(line); size += line.length + 1; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'svg') return NodeFilter.FILTER_REJECT;
          if (!visible(node) || S.hiddenBox(node)) return NodeFilter.FILTER_REJECT;
        } else if (S.textHidden(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (size > MAX) break;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (el.matches(INTERACTIVE)) {
          const ref = S.addRef(el);
          n++;
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          const secret = S.check(el);
          let desc = '[' + ref + '] ' + tag + (type ? '[type=' + type + ']' : '') + ' "' + label(el, secret) + '"';
          if (tag === 'a') { const href = el.getAttribute('href') || ''; if (href && !href.startsWith('javascript:')) desc += ' -> ' + href.slice(0, 100); }
          if (tag === 'input' && (type === 'checkbox' || type === 'radio')) desc += el.checked ? ' (checked)' : ' (unchecked)';
          if (secret) desc += el.value ? ${JSON.stringify(maskedState('x'))} : ${JSON.stringify(maskedState(''))};
          else if (tag === 'select') desc += ' = "' + clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text) + '"';
          push(desc);
        } else if (MODE === 'all' && /^H[1-6]$/.test(el.tagName)) {
          push(el.tagName.toLowerCase() + ': ' + clean(el.innerText).slice(0, 200));
        }
      } else if (MODE === 'all') {
        const t = clean(node.textContent);
        if (!t) continue;
        const p = node.parentElement;
        if (!p || p.closest(INTERACTIVE) || p.closest('h1,h2,h3,h4,h5,h6')) continue;
        push(t.slice(0, 300));
      }
    }
    return { text: lines.join('\\n'), count: n, truncated: size > MAX };
  `);
}

/**
 * Runs inside the page (in the safety world): where a click on the ref'd element (scrolled into view) or at a viewport
 * point lands, by the hit test of S.aim. The page is only scrolled.
 */
export function aimScript(target: { ref: string; scroll?: boolean } | { x: number; y: number }): string {
  const t = 'ref' in target ? { ref: target.ref, scroll: target.scroll !== false } : { x: Number(target.x) || 0, y: Number(target.y) || 0 };
  return inSafetyWorld(`return S.aim(${JSON.stringify(t)});`);
}

/** Runs inside the page (in the safety world): a human-readable description of a ref'd element, or null. */
export function describeScript(ref: string): string {
  return inSafetyWorld(`const f = S.byRef(${JSON.stringify(ref)}); return f.el ? S.label(f.el) : null;`);
}

/**
 * Runs inside the page (in the safety world): the kind of credential the field about to be typed into holds, or
 * null. It looks at the element with `ref` (and the field it leads to: a label's control, or the field inside a
 * wrapper) and, with `active`, also at the focused one (through shadow roots and frames of the same site); a
 * credential field found is remembered as one from now on. crossOrigin: the focus is in a frame from another site,
 * which only that frame can answer for.
 */
export function targetScript(ref: string | undefined, active: boolean): string {
  return inSafetyWorld(`
    const found = ${ref ? `S.byRef(${JSON.stringify(ref)})` : '{}'};
    const el = found.el || null;
    const FIELDS = 'input, textarea, select';
    const inner = el && !el.matches(FIELDS) ? el.control || el.querySelector(FIELDS) || (el.shadowRoot && el.shadowRoot.querySelector(FIELDS)) || null : null;
    const act = ${active ? 'S.deepActive()' : '{ el: null, crossOrigin: false }'};
    const kind = (el && S.check(el)) || (inner && S.check(inner)) || (act.el && S.check(act.el)) || null;
    for (const f of [el, inner, act.el]) if (f) S.mark(f);
    return { kind, crossOrigin: !kind && act.crossOrigin };
  `);
}

/**
 * Runs inside the page (in the safety world), changing nothing: the kind of the visible credential field whose label
 * or placeholder contains `field`, or null. browser_type asks before the call is stored, when earlier calls of the
 * same reply have not run yet, so it must not renumber the refs as browser_read_page does.
 */
export function fieldKindScript(field: string): string {
  return inSafetyWorld(`
    const q = ${JSON.stringify(field.trim().toLowerCase())};
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const kind = S.check(el);
      if (!kind) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const label = clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'));
      if (q && label.includes(q)) return kind;
    }
    return null;
  `);
}

/**
 * Runs inside the page (in the safety world), changing nothing: whether it shows a password field (S.check, so a
 * field typed into as one counts after "Show password"), in the document or an open shadow root. The sign-in page signal.
 */
export function passwordFieldScript(): string {
  return inSafetyWorld(`
    const shown = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
    const roots = [document];
    for (let i = 0; i < roots.length && i < 64; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    return roots.some((r) => [...r.querySelectorAll('input, textarea')].some((el) => S.check(el) === 'password' && shown(el)));
  `);
}

/** Runs inside the page (in the safety world): briefly outlines the element the agent is about to act on, so the user can follow along. */
export function flashScript(ref: string): string {
  return inSafetyWorld(`const f = S.byRef(${JSON.stringify(ref)}); if (!f.el) return false; S.flash(f.el); return true;`);
}

/** Runs inside the page (in the safety world): the first line holding `text`, or the element matching `selector`. */
export function waitScript(text: string | undefined, selector: string | undefined): string {
  return inSafetyWorld(`
    const text = ${JSON.stringify(text ?? '')}.toLowerCase();
    const selector = ${JSON.stringify(selector ?? '')};
    if (selector) { try { const el = document.querySelector(selector); if (el) return { line: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }; } catch (e) { return 'bad-selector'; } }
    if (text && document.body) {
      const lines = S.visibleText(document.body).split('\\n');
      const hit = lines.find((l) => l.toLowerCase().includes(text));
      if (hit !== undefined) return { line: hit.replace(/\\s+/g, ' ').trim().slice(0, 200) };
    }
    return false;
  `);
}

/** Runs inside the page (in the safety world): the text a person can see on the page (S.visibleText), main content first. */
export function getTextScript(): string {
  return inSafetyWorld(`const m = document.querySelector('main, article, [role="main"]'); const main = m ? S.visibleText(m) : ''; return main.length > 200 ? main : S.visibleText(document.body);`);
}

/** Runs inside the page (in the safety world): selects what the focused field holds, so typing replaces it. */
export function selectAllScript(): string {
  return inSafetyWorld(`const el = S.deepActive().el; if (!el) return; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select(); else if (el.isContentEditable) { const s = getSelection(); s.selectAllChildren(el); }`);
}

/** Runs inside the page (in the safety world): scrolls by (dx, dy) and says where the page is. */
export function scrollScript(dx: number, dy: number): string {
  return inSafetyWorld(`window.scrollBy({ left: ${Number(dx) || 0}, top: ${Number(dy) || 0}, behavior: 'instant' }); return { x: scrollX, y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight };`);
}
