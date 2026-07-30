const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const startOfDay = (at: Date): number =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** Elapsed time an operator can read at a glance: `48s`, `14m`, `3h 06m`, `2d 4h`. */
export const elapsed = (fromMs: number, nowMs: number): string => {
  const total = Math.max(0, nowMs - fromMs);
  if (total < MINUTE_MS) {
    return `${Math.floor(total / 1000)}s`;
  }
  if (total < HOUR_MS) {
    return `${Math.floor(total / MINUTE_MS)}m`;
  }
  if (total < DAY_MS) {
    const hours = Math.floor(total / HOUR_MS);
    return `${hours}h ${String(Math.floor((total % HOUR_MS) / MINUTE_MS)).padStart(2, '0')}m`;
  }
  return `${Math.floor(total / DAY_MS)}d ${Math.floor((total % DAY_MS) / HOUR_MS)}h`;
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** Clock time, with the date added only once it stops being today's. */
export const startedAt = (atMs: number, nowMs: number): string => {
  const at = new Date(atMs);
  const time = TIME_FORMAT.format(at);
  return startOfDay(at) === startOfDay(new Date(nowMs))
    ? time
    : `${DATE_FORMAT.format(at)} ${time}`;
};
