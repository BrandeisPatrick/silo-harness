// Keeps credentials out of what the browser tools tell the agent. A password, a one-time code or a card number typed
// into a page (by the user, or by the agent for them) never appears in a tool result, and so never reaches the
// transcript, hooks, the history, exports or the remote page: the field shows as ••• instead.
//
// The detection is one plain function (credentialKind) that the tests call directly and that browser.ts also runs
// inside each page, from pagePrelude(), in a world of its own that neither the page nor code the agent runs with
// browser_eval can see or change.

/** What a credential field's value reads as in every browser tool result. */
export const MASK = '•••';

/**
 * A value shorter than this is hidden only where it stands alone (the whole result, or a whole JSON string), not
 * wherever its characters occur: hiding every "12" of a page because an expiry month is 12 would garble the text.
 */
export const MIN_SCRUB = 3;

/** The isolated world the safety scripts run in (0 is the page's own, 999 Electron's preload world). */
export const SAFETY_WORLD = 1037;

/** A form field as the detection sees it. */
export interface FieldInfo {
  /** The tag name, any case: input, textarea or select */
  tag: string;
  /** input's type (the property, so an unknown type reads "text") */
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  /** The field was a password field when it was typed into, or earlier while the page was open */
  wasSecret?: boolean;
}

export type CredentialKind = 'password' | 'one-time code' | 'card';

/**
 * The kind of credential a form field holds, or null for an ordinary field (a username, an email, a search box).
 * Credential fields: type=password; autocomplete current-password, new-password, one-time-code or any cc-*; a name
 * or id that reads like a password, a one-time code, a card number or its security code; and a field that was a
 * password field when it was typed into (wasSecret), which "Show password" does not turn back into an ordinary one.
 *
 * Its source also runs inside pages (pagePrelude), so it stays self-contained: no imports, no module-level names.
 */
export function credentialKind(f: FieldInfo): CredentialKind | null {
  const tag = String(f.tag || '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
  const type = String(f.type || '').toLowerCase().trim();
  if (f.wasSecret || (tag === 'input' && type === 'password')) return 'password';
  // Buttons and choices hold a fixed value, never one typed in
  if (tag === 'input' && /^(checkbox|radio|submit|button|reset|image|file|range|color)$/.test(type)) return null;
  const tokens = String(f.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'one-time code';
  if (tokens.some((t) => t.startsWith('cc-'))) return 'card';
  for (const raw of [f.name, f.id]) {
    if (!raw) continue;
    // "loginPassword", "user_pass", "otp-1", "CVV2" → words, and the words run together
    const words = String(raw).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const joined = words.join('');
    if (words.some((w) => /^(pass|passwd|password|passphrase|passcode|pwd|pw)\d*$/.test(w)) || /password|passwd|passphrase|passcode/.test(joined)) return 'password';
    if (words.some((w) => /^(otp|totp|hotp|mfa|2fa)\d*$/.test(w)) || /onetime(code|password|pin|token)|verificationcode|mfacode|twofactor/.test(joined)) return 'one-time code';
    if (words.some((w) => /^(cvc|cvv|cvn|csc|ccv)\d*$/.test(w)) || /cardnumber|cardnum|cardno|ccnumber|ccnum|creditcard|securitycode|cardverification|cardcode/.test(joined)) return 'card';
  }
  return null;
}

/** How an outline line ends for a credential field: the value is never shown, only whether there is one. */
export function maskedState(value: string | null | undefined): string {
  return value ? ` = "${MASK}"` : ' (empty)';
}

/**
 * Whether the label or placeholder the agent names a field by (browser_type's `field`) reads like a credential
 * field's. Used before the page can be asked, to keep the text out of the transcript.
 */
export function looksLikeCredentialLabel(label: string): boolean {
  return /\bpass(word|code|phrase)?\b|\bpwd\b|\bpin\b|\botp\b|one[- ]?time|verification code|security code|\bcvc\b|\bcvv\b|\bcsc\b|card number|\b2fa\b|two[- ]factor|authenticat(or|ion) code/i.test(label);
}

/**
 * `text` with every credential value in `secrets` replaced by •••: as it is, as it reads inside a JSON string, and
 * a whole result or JSON string that is exactly the value. Values shorter than MIN_SCRUB are only replaced where
 * they stand alone. Longer values go first, so one that contains another is hidden whole.
 */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  if (!text) return text;
  const list = [...new Set([...secrets].filter((s): s is string => typeof s === 'string' && s.trim().length > 0))].sort((a, b) => b.length - a.length);
  if (!list.length) return text;
  if (list.includes(text) || list.includes(text.trim())) return MASK;
  let out = text;
  for (const s of list) {
    const inJson = JSON.stringify(s).slice(1, -1);
    out = out.split(`"${inJson}"`).join(`"${MASK}"`);
    if (s.length >= MIN_SCRUB) {
      out = out.split(s).join(MASK);
      if (inJson !== s) out = out.split(inJson).join(MASK);
    }
  }
  return out;
}

/** "a password field", "a one-time code field", "a card field" */
export function fieldPhrase(kind: string): string {
  return `${/^[aeiou]/i.test(kind) && !/^one/i.test(kind) ? 'an' : 'a'} ${kind} field`;
}

/**
 * browser_type's result for a credential field: how much was typed and where, never what. `kind` is a
 * CredentialKind, or 'embedded' for a field in a frame from another site that could not be looked into.
 */
export function typedSecretMessage(kind: string, chars: number, name: string, ref: string | undefined, submitted: boolean): string {
  const where = kind === 'embedded' ? 'a field in an embedded frame from another site' : fieldPhrase(kind);
  return `Typed ${chars} character${chars === 1 ? '' : 's'} into ${where}${name ? ` '${name}'` : ''}${ref ? ` (${ref})` : ''}${submitted ? ' and pressed Enter' : ''}. The text is not shown because the field holds a credential.`;
}

/**
 * Script text that defines `S` inside the page (in SAFETY_WORLD). The first script in a document also starts
 * watching it: a field typed into while it is a credential field, and a field whose type stops being password,
 * stay credential fields until the page goes. S.check(el) gives a field's kind or null, S.mark(el) remembers a
 * credential field, S.deepActive() finds the focused element through shadow roots and same-origin frames,
 * S.secrets() lists the values of every filled credential field, and S.exposed() the filled ones a screenshot
 * would show: focused, or drawn in clear text inside the viewport. The outline's refs live here too (S.addRef,
 * S.byRef: an element held weakly with the role and name it had), and S.aim decides where a click lands by hit-testing
 * the point with this world's own DOM methods, which the page cannot replace. `globalThis` is this world's, so a
 * page that defines its own __ocSafety changes nothing here.
 */
export function pagePrelude(): string {
  return `const S = globalThis.__ocSafety || (globalThis.__ocSafety = (() => {
    const kindOf = (${credentialKind.toString()});
    const seen = new WeakSet();
    const isField = (el) => !!el && el.nodeType === 1 && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    const check = (el) => isField(el) ? kindOf({ tag: el.tagName, type: el.type, autocomplete: el.getAttribute('autocomplete'), name: el.getAttribute('name'), id: el.id, wasSecret: seen.has(el) }) : null;
    const mark = (el) => { if (check(el)) seen.add(el); };
    try {
      document.addEventListener('input', (e) => mark(e.composedPath()[0]), true);
      new MutationObserver((records) => {
        for (const r of records) if (String(r.oldValue || '').toLowerCase() === 'password' && isField(r.target)) seen.add(r.target);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
      for (const el of document.querySelectorAll('input[type=password]')) seen.add(el);
    } catch (e) {}
    const frameDoc = (el) => { try { return el.contentDocument || null; } catch (e) { return null; } };
    const deepActive = () => {
      let a = document.activeElement;
      for (let i = 0; a && i < 16; i++) {
        if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
        if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
          const d = frameDoc(a);
          if (!d) return { el: a, crossOrigin: true };
          if (d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; }
        }
        break;
      }
      return { el: a, crossOrigin: false };
    };
    const roots = () => {
      const out = [];
      const visit = (root, depth) => {
        if (!root || depth > 6) return;
        out.push(root);
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') visit(frameDoc(el), depth + 1);
        }
      };
      visit(document, 0);
      return out;
    };
    const fields = () => roots().flatMap((r) => [...r.querySelectorAll('input, textarea, select')]);
    const valueOf = (el) => {
      if (el.tagName !== 'SELECT') return el.value || '';
      const o = el.options[el.selectedIndex];
      return [el.value, o ? o.text : ''].filter(Boolean).join('\\n');
    };
    const secrets = () => {
      const out = [];
      for (const el of fields()) if (check(el) && el.value) for (const v of valueOf(el).split('\\n')) if (v) out.push(v);
      return out;
    };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const view = el.ownerDocument.defaultView;
      const s = view.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
    };
    const describe = (el) => {
      const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      return { kind: check(el), label };
    };
    const exposed = () => {
      const active = deepActive().el;
      const out = [];
      for (const el of fields()) {
        if (!check(el) || !el.value) continue;
        if (el === active) out.push({ ...describe(el), focused: true });
        else if (!(el.tagName === 'INPUT' && el.type === 'password') && shown(el)) out.push({ ...describe(el), focused: false });
      }
      return out;
    };
    // ---- Refs and targeting: kept here, where the page cannot read, move or fake them ----
    const EP = Element.prototype;
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const attr = (e, n) => EP.getAttribute.call(e, n) || '';
    const isEditable = (el) => isField(el) || el.isContentEditable;
    const roleOf = (el) => {
      const tag = el.tagName.toLowerCase();
      const type = attr(el, 'type').toLowerCase();
      return attr(el, 'role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button' : tag === 'select' ? 'combobox' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'textbox' : tag);
    };
    const named = (el) => attr(el, 'aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'alt');
    /** What the agent calls an element: its role and a name (a credential field's value never) */
    const label = (el) => ({ role: roleOf(el), name: clean(named(el) || (check(el) ? '' : el.innerText || el.textContent || el.value)).slice(0, 80) });
    /** What a ref must still be when it is used: its role and its name, a field's value left out (typing changes it) */
    const sigOf = (el) => roleOf(el) + '\\u0001' + clean(named(el) || attr(el, 'name') || (isEditable(el) ? '' : el.innerText || el.textContent)).slice(0, 80);
    let refs = new Map();
    let n = 0;
    const resetRefs = () => { refs = new Map(); n = 0; };
    const addRef = (el) => { const r = 'ref_' + (++n); refs.set(r, { w: new WeakRef(el), sig: sigOf(el) }); return r; };
    /** The element a ref names: { el }, or { error: 'missing' | 'changed' } */
    const byRef = (r) => {
      const e = refs.get(r);
      const el = e && e.w.deref();
      if (!el || !el.isConnected) return { error: 'missing' };
      return sigOf(el) === e.sig ? { el } : { error: 'changed' };
    };
    /** What a click on an element (or what is under the point) lands on, for the click rules */
    const clickInfo = (hit) => {
      const CAPTCHA = /recaptcha|h-?captcha|turnstile/i;
      let inCaptcha = false;
      for (let e = hit; e; e = e.parentElement || (e.parentNode && e.parentNode.host) || null) {
        if (e.nodeType === 1 && CAPTCHA.test([e.id, attr(e, 'class'), attr(e, 'src')].join(' '))) { inCaptcha = true; break; }
      }
      const el = EP.closest.call(hit, 'button, a[href], input, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"]') || hit;
      const tag = el.tagName.toLowerCase();
      const type = clean(attr(el, 'type')).toLowerCase();
      const isInputButton = tag === 'input' && /^(submit|button|reset|image)$/.test(type);
      const own = tag === 'input' ? (isInputButton && !check(el) ? el.value : '') : (el.innerText || el.textContent);
      const text = clean(own || attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'alt')).slice(0, 200);
      const form = ((tag === 'button' || tag === 'input') && el.form) || EP.closest.call(el, 'form');
      let formHasCardFields = false;
      let formActionHost = null;
      if (form) {
        const fields = [...EP.querySelectorAll.call(form, 'input, select, textarea')];
        if (form.id) fields.push(...el.ownerDocument.querySelectorAll('[form="' + CSS.escape(form.id) + '"]'));
        formHasCardFields = fields.some((f) => check(f) === 'card');
        const action = clean(attr(el, 'formaction') || attr(form, 'action'));
        if (action) { try { formActionHost = new URL(action, el.ownerDocument.location.href).host || null; } catch (e) {} }
      }
      return { text, role: clean(attr(el, 'role')).toLowerCase(), tag, type, inCaptcha, formHasCardFields, formActionHost };
    };
    /** The element under a viewport point, through open shadow roots and frames of the same site */
    const deepHit = (x, y) => {
      let doc = document;
      let hit = doc.elementFromPoint(x, y);
      for (let i = 0; hit && i < 24; i++) {
        if (hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (inner && inner !== hit) { hit = inner; continue; }
        }
        if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') {
          const d = frameDoc(hit);
          if (!d) return { hit, crossOrigin: true };
          const r = hit.getBoundingClientRect();
          x -= r.left + hit.clientLeft;
          y -= r.top + hit.clientTop;
          const inner = d.elementFromPoint(x, y);
          if (!inner) break;
          doc = d;
          hit = inner;
          continue;
        }
        break;
      }
      return { hit, crossOrigin: false };
    };
    /** Whether the point's element is the target, inside it (across shadow roots) or its label */
    const lands = (el, hit) => {
      for (let e = hit; e; e = e.parentNode || e.host || null) if (e === el) return true;
      for (const l of el.labels || []) for (let e = hit; e; e = e.parentNode || e.host || null) if (e === l) return true;
      return false;
    };
    /**
     * Where a click on a ref (scrolled into view) or at a point goes, decided here: { x, y, target, frame? } with what
     * is really under the point, or { error } when the ref is gone, changed, has no box, or something else covers it.
     * frame: the click goes into a frame from another site (its address and place, for the main process to name).
     */
    const aim = (t) => {
      let el = null;
      let x = t.x;
      let y = t.y;
      if (t.ref) {
        const found = byRef(t.ref);
        if (found.error) return { error: found.error };
        el = found.el;
        if (t.scroll !== false) EP.scrollIntoView.call(el, { block: 'center', inline: 'center' });
        const r = EP.getBoundingClientRect.call(el);
        if (!r.width || !r.height) return { error: 'hidden', ...label(el) };
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
      const { hit, crossOrigin } = deepHit(x, y);
      if (!hit) return { error: el ? 'covered' : 'nothing', ...(el ? label(el) : {}) };
      // A frame from another site under the point (over the target, or where x and y say): a click into that site
      if (crossOrigin) {
        const frames = [...document.querySelectorAll('iframe, frame')];
        return { x, y, target: clickInfo(hit), frame: { src: hit.src || '', name: hit.name || '', index: frames.indexOf(hit) } };
      }
      if (el && !lands(el, hit)) return { error: 'covered', ...label(el) };
      return { x, y, target: clickInfo(hit) };
    };
    const flash = (el) => {
      const r = EP.getBoundingClientRect.call(el);
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #277de2;border-radius:6px;background:rgba(39,125,226,0.16);box-shadow:0 0 0 4px rgba(39,125,226,0.22);transition:opacity 0.45s ease 0.25s;left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
      document.documentElement.appendChild(box);
      requestAnimationFrame(() => { box.style.opacity = '0'; });
      setTimeout(() => box.remove(), 800);
    };
    // ---- Text a person can see: what get_text and the outline give the agent ----
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|HEAD|TITLE|META|LINK)$/;
    /**
     * Whether an element hides itself and everything in it from a person: display none, opacity (almost) 0,
     * aria-hidden, clipped to nothing, a 1×1 box (or none) that hides its overflow, or placed more than a viewport
     * outside the document. Text merely below the fold is not hidden.
     */
    const hiddenBox = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none') return true;
      if (s.display === 'contents') return attr(el, 'aria-hidden') === 'true';
      if (parseFloat(s.opacity) < 0.1) return true;
      if (attr(el, 'aria-hidden') === 'true') return true;
      if (/inset\\(\\s*(100|50)%/.test(s.clipPath)) return true;
      if (/^rect\\(\\s*0(px)?[,\\s]+0(px)?[,\\s]+0(px)?[,\\s]+0(px)?\\s*\\)$/.test(s.clip) && s.position !== 'static') return true;
      const r = EP.getBoundingClientRect.call(el);
      const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
      if (clips && r.width <= 1 && r.height <= 1) return true;
      if (s.position !== 'static') {
        const vw = innerWidth || 1;
        const vh = innerHeight || 1;
        const left = r.left + scrollX;
        const top = r.top + scrollY;
        const docW = Math.max(document.documentElement.scrollWidth, vw);
        const docH = Math.max(document.documentElement.scrollHeight, vh);
        if (left + r.width < -vw || top + r.height < -vh || left > docW + vw || top > docH + vh) return true;
      }
      return false;
    };
    /** A text node's own look: invisible, or smaller than 2 px */
    const textHidden = (node) => {
      const p = node.parentElement;
      if (!p) return true;
      const s = getComputedStyle(p);
      return s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.fontSize) < 2;
    };
    const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|table-row-group|table-header-group|table-footer-group)$/;
    /** The text a person can see under root, in reading order, with line breaks where blocks are */
    const visibleText = (root) => {
      const out = [];
      const walk = (el) => {
        for (let node = el.firstChild; node; node = node.nextSibling) {
          if (node.nodeType === 3) {
            if (textHidden(node)) continue;
            const pre = /^pre/.test(getComputedStyle(node.parentElement).whiteSpace);
            const t = pre ? node.textContent : node.textContent.replace(/\\s+/g, ' ');
            if (t.trim() || (t && out.length && !/\\s$/.test(out[out.length - 1]))) out.push(t);
            continue;
          }
          if (node.nodeType !== 1 || SKIP.test(node.tagName)) continue;
          if (node.tagName === 'BR') { out.push('\\n'); continue; }
          if (hiddenBox(node)) continue;
          const d = getComputedStyle(node).display;
          const block = BLOCK.test(d);
          if (block) out.push('\\n');
          if (d === 'table-cell') out.push('\\t');
          if (node.shadowRoot) walk(node.shadowRoot);
          walk(node);
          if (block) out.push('\\n');
        }
      };
      if (root) walk(root);
      return out.join('').split('\\n').map((l) => l.replace(/[ \\t]+/g, (m) => (m.includes('\\t') ? '\\t' : ' ')).trim()).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    };
    return { check, mark, deepActive, secrets, exposed, label, resetRefs, addRef, byRef, clickInfo, aim, flash, clean, hiddenBox, textHidden, visibleText };
  })());`;
}

/** A script for SAFETY_WORLD: the prelude, then `body` (which returns the result). */
export function inSafetyWorld(body: string): string {
  return `(() => { ${pagePrelude()}\n${body}\n})()`;
}

/**
 * The same checks for a frame from another site, which the safety world of the page cannot look into: run in that
 * frame's own world, it reports the focused field's kind and the filled credential fields a screenshot would show.
 */
export function frameCheckScript(): string {
  return `(() => {
    const kindOf = (${credentialKind.toString()});
    const isField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    const check = (el) => isField(el) ? kindOf({ tag: el.tagName, type: el.type, autocomplete: el.getAttribute('autocomplete'), name: el.getAttribute('name'), id: el.id, wasSecret: false }) : null;
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const exposed = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!check(el) || !el.value) continue;
      const r = el.getBoundingClientRect();
      const clear = !(el.tagName === 'INPUT' && el.type === 'password');
      if (el === a || (clear && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight)) exposed.push({ kind: check(el), label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 60), focused: el === a });
    }
    return { activeKind: check(a), exposed };
  })()`;
}
