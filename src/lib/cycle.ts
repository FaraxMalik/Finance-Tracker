import { addDays, diffDays, parseISODate, shortDate, toISODate, todayISO } from '@/lib/dates';

/** The most recent cycle boundary (e.g. the 5th) on or before `today`. */
export function currentCycleStart(startDay: number, today: string = todayISO()): string {
  const d = parseISODate(today);
  const y = d.getFullYear();
  const m = d.getMonth();
  const thisMonth = new Date(y, m, startDay);
  return toISODate(d.getDate() >= startDay ? thisMonth : new Date(y, m - 1, startDay));
}

/** The first cycle boundary strictly after `start`. */
export function nextBoundary(start: string, startDay: number): string {
  const d = parseISODate(start);
  const candidate = new Date(d.getFullYear(), d.getMonth(), startDay);
  return toISODate(
    candidate.getTime() > d.getTime() ? candidate : new Date(d.getFullYear(), d.getMonth() + 1, startDay),
  );
}

/** Last day of a cycle that opened on `start` (the day before the next boundary). */
export function nominalEnd(start: string, startDay: number): string {
  return addDays(nextBoundary(start, startDay), -1);
}

export function cycleLabel(start: string, end: string): string {
  return `${shortDate(start)} – ${shortDate(end)}`;
}

export type CycleProgress = {
  totalDays: number;
  dayNumber: number;
  daysLeft: number;
  overdue: boolean;
  fraction: number;
};

export function cycleProgress(start: string, startDay: number, today: string = todayISO()): CycleProgress {
  const end = nominalEnd(start, startDay);
  const totalDays = diffDays(start, end) + 1;
  const elapsed = diffDays(start, today) + 1;
  const overdue = today > end;
  return {
    totalDays,
    dayNumber: Math.min(Math.max(elapsed, 1), totalDays),
    daysLeft: Math.max(diffDays(today, end), 0),
    overdue,
    fraction: Math.min(Math.max(elapsed / totalDays, 0), 1),
  };
}
