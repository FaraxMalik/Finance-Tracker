/** Dates are stored as local 'YYYY-MM-DD' strings so they sort and group correctly. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function diffDays(fromISO: string, toISO: string): number {
  const ms = parseISODate(toISO).getTime() - parseISODate(fromISO).getTime();
  return Math.round(ms / 86_400_000);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue" */
export function weekdayShort(iso: string): string {
  return WEEKDAYS[parseISODate(iso).getDay()];
}

/** "5 Sep" */
export function shortDate(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "5 Sep 2026" */
export function longDate(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Today", "Yesterday", or "5 Sep" */
export function relativeDate(iso: string): string {
  const diff = diffDays(iso, todayISO());
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return shortDate(iso);
}

/** "Today · 22 Sep", "Yesterday · 21 Sep", "Sat 19 Sep" (with the year when it isn't this year). */
export function dayLabel(iso: string): string {
  const today = todayISO();
  const diff = diffDays(iso, today);
  if (diff === 0) return `Today · ${shortDate(iso)}`;
  if (diff === 1) return `Yesterday · ${shortDate(iso)}`;
  const year = iso.slice(0, 4) === today.slice(0, 4) ? '' : ` ${iso.slice(0, 4)}`;
  return `${weekdayShort(iso)} ${shortDate(iso)}${year}`;
}
