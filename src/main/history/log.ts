// The history log files: <userData>/history/<sessionId>.jsonl, one HistoryRecord per line, appended synchronously
// and never rewritten. A record is on disk (in the OS's cache, which survives the process being killed) before
// the call returns, so a crash loses at most what had not been recorded yet.

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryRecord } from '../../shared/history';

/** Session ids are UUIDs; anything else never becomes a file name. */
export function safeId(id: string): string | null {
  return typeof id === 'string' && /^[\w-]{1,100}$/.test(id) ? id : null;
}

/** Parses a log's text: one record per line; a line that does not parse (a torn last line after a crash) is skipped. */
export function parseLog(text: string): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HistoryRecord;
      if (r && typeof r === 'object' && typeof r.type === 'string' && typeof r.seq === 'number') out.push(r);
    } catch {
      /* torn or foreign line: skipped, never fatal */
    }
  }
  return out;
}

/** The last record of a log that parses, read backwards in chunks so a large log is not read whole. */
function lastRecord(file: string): { record: HistoryRecord | null; endsWithNewline: boolean } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { record: null, endsWithNewline: true };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return { record: null, endsWithNewline: true };
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    const endsWithNewline = last[0] === 0x0a;
    const CHUNK = 64 * 1024;
    let end = size;
    let tail = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = Buffer.concat([buf, tail]);
      end = start;
      // Every complete line in `tail` (the first may be partial unless we reached the start), newest first.
      const lines = tail.toString('utf8').split('\n');
      const complete = start === 0 ? lines : lines.slice(1);
      for (let i = complete.length - 1; i >= 0; i--) {
        const parsed = parseLog(complete[i]);
        if (parsed.length) return { record: parsed[0], endsWithNewline };
      }
    }
    return { record: null, endsWithNewline };
  } finally {
    fs.closeSync(fd);
  }
}

export class HistoryLog {
  /** Next seq per session, known once the log was first appended to in this process */
  private readonly seqs = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  file(sessionId: string): string {
    return path.join(this.dir, `${safeId(sessionId) ?? 'invalid'}.jsonl`);
  }

  exists(sessionId: string): boolean {
    return fs.existsSync(this.file(sessionId));
  }

  /** Session ids that have a log. */
  ids(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -6))
        .filter((id) => safeId(id));
    } catch {
      return [];
    }
  }

  read(sessionId: string): HistoryRecord[] {
    try {
      return parseLog(fs.readFileSync(this.file(sessionId), 'utf8'));
    } catch {
      return [];
    }
  }

  /** Appends one record; returns it. `t` defaults to now (buffered records keep the time they happened). */
  append(sessionId: string, type: string, data: unknown, t = this.now()): HistoryRecord | null {
    if (!safeId(sessionId)) return null;
    const file = this.file(sessionId);
    let seq = this.seqs.get(sessionId);
    let prefix = '';
    if (seq === undefined) {
      // First write in this process: continue the numbering, and start on a fresh line after a torn one.
      const { record, endsWithNewline } = lastRecord(file);
      seq = (record?.seq ?? 0) + 1;
      if (!endsWithNewline) prefix = '\n';
      // The log holds full message text: the user's alone. A log made before it was created 600 is brought to 600.
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* no log yet: created 600 below */
      }
    }
    const rec: HistoryRecord = { v: 1, seq, t, type, data: data ?? {} };
    fs.appendFileSync(file, prefix + JSON.stringify(rec) + '\n', { mode: 0o600 });
    this.seqs.set(sessionId, seq + 1);
    return rec;
  }

  /** The log moved away (trash) or was removed: the next write starts by reading the file again. */
  forget(sessionId: string): void {
    this.seqs.delete(sessionId);
  }
}
