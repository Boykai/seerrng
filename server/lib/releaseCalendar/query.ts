import { parseOptionalQueryBoolean } from '@server/utils/validation';
export class CalendarQueryError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export interface CalendarQuery {
  start: Date;
  end: Date;
  allDayStart: Date;
  allDayEnd: Date;
  scope: 'mine' | 'all';
  includeUnmonitored: boolean;
  mediaType?: 'movie' | 'tv' | 'music';
}
function date(value: unknown, fallback: Date): Date {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new CalendarQueryError(
      400,
      'Use calendar dates in YYYY-MM-DD format.'
    );
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new CalendarQueryError(400, 'Invalid calendar date.');
  return parsed;
}
function zonedMidnight(value: Date, timeZone: string): Date {
  if (timeZone === 'UTC') return value;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new CalendarQueryError(400, 'Unknown calendar time zone.');
  }
  const target = value.toISOString().slice(0, 10);
  const dateKey = (instant: number) => {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value])
    );
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  // Find the first instant in the local day. A clock change can skip midnight,
  // or repeat it; using date boundaries handles both cases without inventing an hour.
  let low = value.getTime() - 36 * 60 * 60 * 1000;
  let high = value.getTime() + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateKey(middle) < target) low = middle + 1;
    else high = middle;
  }
  if (dateKey(low) !== target)
    throw new CalendarQueryError(
      400,
      'This calendar date does not exist in the selected time zone.'
    );
  return new Date(low);
}

export function parseCalendarQuery(
  query: Record<string, unknown>,
  canViewAll: boolean,
  isAdmin: boolean,
  now = new Date()
): CalendarQuery {
  const start = date(
    query.start,
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  );
  const end = date(
    query.end,
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  );
  if (end <= start || end.getTime() - start.getTime() > 93 * 86400000)
    throw new CalendarQueryError(
      400,
      'Select a calendar range of up to 93 days.'
    );
  const scope = query.scope ?? 'mine';
  if (scope !== 'mine' && scope !== 'all')
    throw new CalendarQueryError(400, 'Unknown calendar scope.');
  if (scope === 'all' && !canViewAll)
    throw new CalendarQueryError(403, 'You cannot view all release calendars.');
  const mediaType = query.mediaType;
  if (
    mediaType !== undefined &&
    mediaType !== 'movie' &&
    mediaType !== 'tv' &&
    mediaType !== 'music'
  )
    throw new CalendarQueryError(400, 'Unknown calendar media type.');
  const parsedUnmonitored = parseOptionalQueryBoolean(
    query.includeUnmonitored,
    'includeUnmonitored'
  );
  if ('error' in parsedUnmonitored)
    throw new CalendarQueryError(400, parsedUnmonitored.error);
  const includeUnmonitored = parsedUnmonitored.value === true;
  if (includeUnmonitored && !isAdmin)
    throw new CalendarQueryError(
      403,
      'Only administrators can include unmonitored titles.'
    );
  const timeZone = query.timeZone ?? 'UTC';
  if (typeof timeZone !== 'string' || timeZone.length > 64)
    throw new CalendarQueryError(400, 'Invalid calendar time zone.');
  return {
    start: zonedMidnight(start, timeZone),
    end: zonedMidnight(end, timeZone),
    allDayStart: start,
    allDayEnd: end,
    scope,
    includeUnmonitored,
    mediaType,
  };
}
