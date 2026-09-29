import { getRepository } from '@server/datasource';
import ReleaseCalendarSnapshot from '@server/entity/ReleaseCalendarSnapshot';
import { In, LessThan } from 'typeorm';
import type {
  ReleaseCalendarDateChange,
  ReleaseCalendarItem,
} from './normalize';

const batchSize = 100;
const annotationBatchSize = 500;
const maxSnapshotAge = 36 * 60 * 60 * 1000;
const snapshotRetention = 14 * 24 * 60 * 60 * 1000;
const historyRetention = 180 * 24 * 60 * 60 * 1000;
const maxChangesPerEvent = 10;
const changesShownPerEvent = 3;

const dateChange = (value: unknown): value is ReleaseCalendarDateChange => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.previousStartsAt === 'string' &&
    Number.isFinite(Date.parse(item.previousStartsAt)) &&
    typeof item.startsAt === 'string' &&
    Number.isFinite(Date.parse(item.startsAt)) &&
    typeof item.changedAt === 'string' &&
    Number.isFinite(Date.parse(item.changedAt)) &&
    typeof item.previousAllDay === 'boolean' &&
    typeof item.allDay === 'boolean'
  );
};

function readHistory(value: string | undefined): ReleaseCalendarDateChange[] {
  try {
    const history: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(history) ? history.filter(dateChange) : [];
  } catch {
    return [];
  }
}

function recentHistory(
  value: string | undefined,
  now: Date
): ReleaseCalendarDateChange[] {
  const cutoff = now.getTime() - historyRetention;
  return readHistory(value).filter(
    (change) => Date.parse(change.changedAt) >= cutoff
  );
}

export async function annotateReleaseCalendarHistory(
  items: ReleaseCalendarItem[],
  now = new Date()
): Promise<ReleaseCalendarItem[]> {
  if (!items.length) return items;

  const repository = getRepository(ReleaseCalendarSnapshot);
  const historyByEvent = new Map<string, ReleaseCalendarDateChange[]>();
  for (let index = 0; index < items.length; index += annotationBatchSize) {
    const batch = items.slice(index, index + annotationBatchSize);
    const snapshots = await repository.findBy({
      eventId: In(batch.map((item) => item.id)),
    });
    for (const snapshot of snapshots) {
      const history = recentHistory(snapshot.history, now)
        .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
        .slice(0, changesShownPerEvent);
      if (history.length) historyByEvent.set(snapshot.eventId, history);
    }
  }

  return items.map((item) => {
    const dateChanges = historyByEvent.get(item.id);
    return dateChanges ? { ...item, dateChanges } : item;
  });
}

export async function recordReleaseCalendarSnapshots(
  items: ReleaseCalendarItem[],
  now = new Date()
): Promise<{ observed: number; changed: number; expired: number }> {
  const repository = getRepository(ReleaseCalendarSnapshot);
  const observedAt = now.toISOString();
  let changed = 0;

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const snapshots = await repository.findBy({
      eventId: In(batch.map((item) => item.id)),
    });
    const previousByEvent = new Map(
      snapshots.map((snapshot) => [snapshot.eventId, snapshot])
    );
    const rows = batch.map((item) => {
      const previous = previousByEvent.get(item.id);
      const history = recentHistory(previous?.history, now);
      const previousAge = previous
        ? now.getTime() - Date.parse(previous.observedAt)
        : Number.POSITIVE_INFINITY;
      if (
        previous &&
        previousAge >= 0 &&
        previousAge <= maxSnapshotAge &&
        (previous.startsAt !== item.startsAt || previous.allDay !== item.allDay)
      ) {
        history.push({
          previousStartsAt: previous.startsAt,
          startsAt: item.startsAt,
          changedAt: observedAt,
          previousAllDay: previous.allDay,
          allDay: item.allDay,
        });
        changed += 1;
      }
      return repository.create({
        eventId: item.id,
        startsAt: item.startsAt,
        allDay: item.allDay,
        observedAt,
        history: JSON.stringify(history.slice(-maxChangesPerEvent)),
      });
    });
    await repository.upsert(rows, ['eventId']);
  }

  const expired = await repository.delete({
    observedAt: LessThan(
      new Date(now.getTime() - snapshotRetention).toISOString()
    ),
  });
  return {
    observed: items.length,
    changed,
    expired: expired.affected ?? 0,
  };
}
