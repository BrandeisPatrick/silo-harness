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
 * would show: focused, or drawn in clear text inside the viewport.
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
    return { check, mark, deepActive, secrets, exposed };
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
