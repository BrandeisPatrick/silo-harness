// The scripts the controller runs inside pages: the outline with refs that browser_read_page returns, the element
// lookups behind browser_click and browser_type, the flash on an element the agent is about to touch, and the
// polling behind browser_wait_for. Those that look at form fields run in the safety world (see safety.ts), so a
// credential field's value never comes back.

import { inSafetyWorld, maskedState } from './safety';

/** The attribute the outline marks interactive elements with; refs look like ref_12. */
export const REF_ATTR = 'data-oc-ref';
export const REF_RE = /^ref_\d+$/;

/**
 * Runs inside the page (in the safety world): labels visible interactive elements with ref ids and returns a
 * compact outline. A credential field's value is never in it: its line ends = "•••" or (empty).
 */
export function readPageScript(mode: 'interactive' | 'all', maxChars: number): string {
  return inSafetyWorld(`
    const REF = ${JSON.stringify(REF_ATTR)};
    const MODE = ${JSON.stringify(mode)};
    const MAX = ${maxChars};
    if (!document.body) return { text: '(empty page)', count: 0, truncated: false, title: document.title, url: location.href };
    const INTERACTIVE = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="textbox"],[role="combobox"],[role="option"],[role="switch"],[contenteditable="true"]';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const label = (el, secret) => clean(
      el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (secret ? '' : ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : '') || el.innerText || el.textContent)
    ).slice(0, 120);
    document.querySelectorAll('[' + REF + ']').forEach((e) => e.removeAttribute(REF));
    const lines = []; let n = 0; let size = 0;
    const push = (line) => { lines.push(line); size += line.length + 1; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'svg') return NodeFilter.FILTER_REJECT;
          if (!visible(node)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (size > MAX) break;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (el.matches(INTERACTIVE)) {
          const ref = 'ref_' + (++n);
          el.setAttribute(REF, ref);
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
    return { text: lines.join('\\n'), count: n, truncated: size > MAX, title: document.title, url: location.href };
  `);
}

export function rectScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
  })()`;
}

/** Runs inside the page (in the safety world): a human-readable description of a ref'd element. */
export function describeScript(ref: string): string {
  return inSafetyWorld(`
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return null;
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button' : tag === 'select' ? 'combobox' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'textbox' : tag);
    const secret = S.check(el);
    const name = clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (secret ? '' : el.innerText || el.textContent || el.value)).slice(0, 80);
    return { role, name };
  `);
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
    const el = ${ref ? `document.querySelector('[${REF_ATTR}="${ref}"]')` : 'null'};
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

/** Runs inside the page: briefly outlines the element the agent is about to act on, so the user can follow along. */
export function flashScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[${REF_ATTR}="${ref}"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-oc-flash', '1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #277de2;border-radius:6px;background:rgba(39,125,226,0.16);box-shadow:0 0 0 4px rgba(39,125,226,0.22);transition:opacity 0.45s ease 0.25s;left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
    document.documentElement.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '0'; });
    setTimeout(() => box.remove(), 800);
    return true;
  })()`;
}

export function waitScript(text: string | undefined, selector: string | undefined): string {
  return `(() => {
    const text = ${JSON.stringify(text ?? '')}.toLowerCase();
    const selector = ${JSON.stringify(selector ?? '')};
    if (selector) { try { const el = document.querySelector(selector); if (el) return { line: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }; } catch (e) { return 'bad-selector'; } }
    if (text && document.body) {
      const lines = document.body.innerText.split('\\n');
      const hit = lines.find((l) => l.toLowerCase().includes(text));
      if (hit !== undefined) return { line: hit.replace(/\\s+/g, ' ').trim().slice(0, 200) };
    }
    return false;
  })()`;
}

/** The visible text of the page, main content first. */
export const GET_TEXT_SCRIPT = `(() => { const m = document.querySelector('main, article, [role="main"]'); const el = (m && m.innerText && m.innerText.length > 200) ? m : document.body; return el ? el.innerText : ''; })()`;

/** Selects what the focused field holds, so typing replaces it. */
export const SELECT_ALL_SCRIPT = `(() => { const el = document.activeElement; if (!el) return; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select(); else if (el.isContentEditable) { const s = getSelection(); s.selectAllChildren(el); } })()`;

export function scrollScript(dx: number, dy: number): string {
  return `(() => { window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' }); return { x: scrollX, y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight }; })()`;
}
