import { getReleaseCalendar } from '@server/lib/releaseCalendar';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { recordReleaseCalendarSnapshots } from './historyStore';

const observationWindow = 93 * 24 * 60 * 60 * 1000;

export async function captureReleaseCalendarHistory(
  now = new Date()
): Promise<void> {
  const settings = getSettings();
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
    { includeDateHistory: false, includeSoftware: false }
  );
  const summary = await recordReleaseCalendarSnapshots(results, now);
  if (partialSources.length || truncated) {
    logger.warn('Release calendar history was only partially refreshed.', {
      label: 'Release Calendar',
      configuredSources:
        settings.radarr.length +
        settings.sonarr.length +
        settings.lidarr.length +
        settings.readarr.length +
        settings.mylar.length +
        settings.kapowarr.length +
        settings.lazylibrarian.length,
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
