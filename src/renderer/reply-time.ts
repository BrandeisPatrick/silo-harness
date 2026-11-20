// When a reply was written, in its actions row after Copy, in caption size: "Just now", "5 min ago", "14:02" earlier
// today, "Yesterday 14:02", then the date ("12 Nov", with the year when it is not this one). The full date and time
// are its tooltip. The words follow the clock: every caption on screen is redrawn each half minute. Imports nothing,
// so test/reply-time.js loads it as it is.

const MINUTE = 60_000;

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The caption for a reply written at `at` (ms), seen at `now`. */
export function replyTimeText(at: number, now = Date.now()): string {
  const ago = now - at;
  if (ago < MINUTE) return 'Just now';
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  const d = new Date(at);
  const n = new Date(now);
  const today = dayStart(n);
  if (at >= today) return clock(d);
  if (dayStart(d) === dayStart(new Date(today - 1))) return `Yesterday ${clock(d)}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

/** The tooltip: the whole date and time */
function fullTime(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(d)}`;
}

let ticking = false;

function redraw(): void {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>('.msg-time[data-at]')) {
    const text = replyTimeText(Number(el.dataset.at), now);
    if (el.textContent !== text) el.textContent = text;
  }
}

/** Puts the reply's time in its actions row (once; a later call moves it to the new time). */
export function stampReply(reply: Element | null | undefined, at: number): void {
  const actions = reply?.querySelector(':scope > .msg-actions');
  if (!actions || !Number.isFinite(at) || at <= 0) return;
  let el = actions.querySelector<HTMLElement>(':scope > .msg-time');
  if (!el) {
    el = document.createElement('span');
    el.className = 'msg-time';
    actions.appendChild(el);
  }
  el.dataset.at = String(at);
  el.title = fullTime(at);
  el.textContent = replyTimeText(at);
  if (!ticking) {
    ticking = true;
    window.setInterval(redraw, 30_000);
  }
}
