import { getReleaseCalendar } from '@server/lib/releaseCalendar';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { recordReleaseCalendarSnapshots } from './historyStore';

const observationWindow = 93 * 24 * 60 * 60 * 1000;

export async function captureReleaseCalendarHistory(
  now = new Date()
): Promise<void> {
  const allDayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const allDayEnd = new Date(allDayStart.getTime() + observationWindow);
  const { results, partialSources, truncated } = await getReleaseCalendar(
    {
      start: now,
      end: allDayEnd,
      allDayStart,
      allDayEnd,
      scope: 'all',
      includeUnmonitored: false,
    },
    0,
    true,
    { includeDateHistory: false }
  );
  const summary = await recordReleaseCalendarSnapshots(results, now);
  if (partialSources.length || truncated) {
    logger.warn('Release calendar history was only partially refreshed.', {
      label: 'Release Calendar',
      configuredSources:
        getSettings().radarr.length + getSettings().sonarr.length,
      unavailableSources: partialSources.length,
      truncated,
      observedEvents: summary.observed,
    });
  } else {
    logger.info('Release calendar history refreshed.', {
      label: 'Release Calendar',
      observedEvents: summary.observed,
      changedEvents: summary.changed,
      expiredSnapshots: summary.expired,
    });
  }
}
