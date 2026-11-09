// Certificate errors in the Browser pane. Chromium's default stands: a page whose certificate is not valid does not
// load. When that happens to a tab's main frame the tab records it (host, code, fingerprint) and the pane covers the
// tab with an interstitial of its own (drawn by the window, not served from a scheme): "This connection is not
// private", the code in words, Go back, and "Proceed anyway (unsafe)". Proceed is an RPC only the window calls; it
// lets that host with that certificate through until the app quits. The agent's navigation result says the
// certificate is not valid and that only the user can proceed; no tool can.
//
// The pieces that decide (the words, the proceeded set, the pill's state) are pure: test/browser-certificates.js.

import type { App as ElectronApp, Certificate, WebContents } from 'electron';
import type { CertErrorState, PageSecurity } from '../../shared/browser';

const WORDS: Record<string, string> = {
  ERR_CERT_AUTHORITY_INVALID: 'Its certificate is not issued by an authority this Mac trusts',
  ERR_CERT_DATE_INVALID: 'Its certificate has expired or is not valid yet',
  ERR_CERT_COMMON_NAME_INVALID: 'Its certificate is for a different site',
  ERR_CERT_REVOKED: 'Its certificate was revoked',
};

/** Chromium's code in words, for the interstitial ("net::ERR_CERT_DATE_INVALID" → "Its certificate has expired …"); an unknown code is shown as it is. */
export function certErrorWords(code: string): string {
  const bare = String(code ?? '').trim().replace(/^net::/, '');
  return WORDS[bare] ?? (String(code ?? '').trim() || 'Its certificate is not valid');
}

/** The host of a URL ("localhost", "example.com"), without the port: the certificate is the host's. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** What browser_navigate (and an action that lands on such a page) returns for a tab stopped at a certificate error. */
export function certificateSentence(e: Pick<CertErrorState, 'host' | 'code'>): string {
  return `The certificate for ${e.host} is not valid (${e.code}). Only the user can proceed.`;
}

/** The (host, fingerprint) pairs the user proceeded past, for one app run. */
export function createProceedSet() {
  const pairs = new Set<string>();
  const hosts = new Map<string, number>();
  const k = (host: string, fingerprint: string) => `${host.toLowerCase()}\n${fingerprint}`;
  return {
    add(host: string, fingerprint: string): void {
      const key = k(host, fingerprint);
      if (pairs.has(key)) return;
      pairs.add(key);
      hosts.set(host.toLowerCase(), (hosts.get(host.toLowerCase()) ?? 0) + 1);
    },
    has: (host: string, fingerprint: string): boolean => pairs.has(k(host, fingerprint)),
    /** Whether the user proceeded past any certificate of this host (the pill's amber triangle) */
    hasHost: (host: string): boolean => hosts.has(String(host).toLowerCase()),
    clear(): void {
      pairs.clear();
      hosts.clear();
    },
    get size(): number {
      return pairs.size;
    },
  };
}

export type ProceedSet = ReturnType<typeof createProceedSet>;

/** The pairs of this run (the module is loaded once per app run). */
export const proceeded = createProceedSet();

/** What the URL pill shows for a page: a lock (https), Not secure (http), the amber triangle (proceeded past), the globe. */
export function pageSecurity(url: string, set: Pick<ProceedSet, 'hasHost'> = proceeded): PageSecurity {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'none';
  }
  if (u.protocol === 'http:') return 'insecure';
  if (u.protocol === 'https:') return set.hasHost(u.hostname) ? 'proceeded' : 'secure';
  return 'none';
}

/** The record a tab keeps of a certificate error. */
export function certErrorState(url: string, code: string, fingerprint: string): CertErrorState {
  return { host: hostOf(url), code, fingerprint, url, reason: certErrorWords(code) };
}

export interface CertificateHost {
  /** Whether these contents belong to the browser's session (a tab or a popup) */
  isBrowser(wc: WebContents): boolean;
  /** A tab's main frame failed: true when the contents were a tab's (it shows the interstitial) */
  onError(wc: WebContents, error: CertErrorState): boolean;
}

let installedOn: ElectronApp | null = null;

/**
 * app.on('certificate-error') for the pane: main frames only, and only for a (host, fingerprint) pair the user
 * proceeded past is the default rejection overridden. Everything else (sub-resources, frames, the app's own pages) is
 * left to Chromium's rejection.
 */
export function installCertificateHandler(electronApp: ElectronApp, host: CertificateHost): void {
  if (installedOn === electronApp) return;
  installedOn = electronApp;
  electronApp.on('certificate-error', (event, wc: WebContents, url: string, error: string, certificate: Certificate, callback: (ok: boolean) => void, isMainFrame: boolean) => {
    if (!wc || wc.isDestroyed() || !host.isBrowser(wc) || !isMainFrame) return;
    const fingerprint = certificate?.fingerprint ?? '';
    const h = hostOf(url);
    if (h && fingerprint && proceeded.has(h, fingerprint)) {
      event.preventDefault();
      callback(true);
      return;
    }
    host.onError(wc, certErrorState(url, error, fingerprint));
  });
}
