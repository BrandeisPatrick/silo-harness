// The ports the app itself listens on, which the agent's browser never opens, reads or acts on (policy.ts
// ownServerRule): the remote-control server's (Settings, or the port it picked, kept in <userData>/remote.json), and
// a debugging port Electron or Node was started with (--remote-debugging-port, --inspect, --inspect-brk,
// --inspect-port, or an inspector opened later). The machine's own network addresses come with them, since the remote
// server can listen on the LAN.

import inspector from 'node:inspector';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let remotePorts: () => number[] = () => [];

const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536;

/** The ports of the app's remote-control server: the configured one, and the one remote.json says it picked. */
export function remoteServerPorts(userData: string, configured: number | undefined): number[] {
  const out: number[] = [];
  if (valid(configured)) out.push(configured);
  try {
    const port = (JSON.parse(fs.readFileSync(path.join(userData, 'remote.json'), 'utf8')) as { port?: unknown }).port;
    if (valid(port)) out.push(port);
  } catch {
    /* no remote server yet */
  }
  return out;
}

/** feature.ts: where the remote server's ports come from. */
export function setRemotePorts(fn: () => number[]): void {
  remotePorts = fn;
}

/** The debugging ports in a command line (Electron's and Node's switches; --inspect alone is 9229). */
export function debugPortsOf(argv: readonly string[]): number[] {
  const out: number[] = [];
  for (const arg of argv) {
    const m = /^--(remote-debugging-port|inspect|inspect-brk|inspect-port|debug)(?:=(.*))?$/.exec(String(arg));
    if (!m) continue;
    if (m[2] === undefined) {
      if (m[1] !== 'remote-debugging-port') out.push(9229);
      continue;
    }
    const port = Number(m[2].split(':').pop());
    if (valid(port)) out.push(port);
  }
  return out;
}

/** Every port the app listens on that the agent must not reach. */
export function ownPorts(): number[] {
  const out = [...remotePorts(), ...debugPortsOf([...process.argv, ...process.execArgv])];
  try {
    const u = inspector.url();
    if (u) {
      const port = Number(new URL(u).port);
      if (valid(port)) out.push(port);
    }
  } catch {
    /* no inspector */
  }
  return [...new Set(out)];
}

/** This machine's own network addresses (the remote server may listen on them). */
export function localAddresses(): string[] {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is os.NetworkInterfaceInfo => Boolean(a))
      .map((a) => a.address);
  } catch {
    return [];
  }
}
