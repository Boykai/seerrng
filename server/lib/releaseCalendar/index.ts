import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { getSettings } from '@server/lib/settings';
import {
  BoundedTaskQueue,
  mapWithConcurrency,
} from '@server/utils/concurrency';
import { normalizeCalendarRow, type ReleaseCalendarItem } from './normalize';
import type { CalendarQuery } from './query';

const calendarQueue = new BoundedTaskQueue(3, 32);

export async function getReleaseCalendar(
  query: CalendarQuery,
  userId: number,
  isAdmin: boolean
) {
  const settings = getSettings();
  const sources = [
    ...settings.radarr.map((server) => ({
      source: 'radarr' as const,
      mediaType: 'movie' as const,
      server,
    })),
    ...settings.sonarr.map((server) => ({
      source: 'sonarr' as const,
      mediaType: 'tv' as const,
      server,
    })),
  ].filter(
    (item) =>
      isMediaCategoryEnabled(item.mediaType) &&
      (!query.mediaType || item.mediaType === query.mediaType)
  );
  let sourceTruncated = false;
  const partialSources: { source: string; serverId?: number }[] = [];
  const batches = await mapWithConcurrency(
    sources.slice(0, 20),
    3,
    async ({ source, server }) => {
      try {
        const api =
          source === 'radarr'
            ? new RadarrAPI({
                url: RadarrAPI.buildUrl(server, '/api/v3'),
                apiKey: server.apiKey,
              })
            : new SonarrAPI({
                url: SonarrAPI.buildUrl(server, '/api/v3'),
                apiKey: server.apiKey,
              });
        const rows = await calendarQueue.run(() =>
          api.getReleaseCalendar(
            new Date(
              Math.min(query.start.getTime(), query.allDayStart.getTime())
            ).toISOString(),
            new Date(
              Math.max(query.end.getTime(), query.allDayEnd.getTime())
            ).toISOString(),
            query.includeUnmonitored
          )
        );
        if (api instanceof SonarrAPI) {
          const missingIds = [
            ...new Set(
              rows.flatMap((row) =>
                row &&
                typeof row === 'object' &&
                !(
                  'series' in row &&
                  row.series &&
                  typeof row.series === 'object'
                ) &&
                'seriesId' in row &&
                typeof row.seriesId === 'number' &&
                Number.isSafeInteger(row.seriesId) &&
                row.seriesId > 0
                  ? [row.seriesId]
                  : []
              )
            ),
          ];
          if (missingIds.length > 200) sourceTruncated = true;
          let missingSeries = false;
          const series = await mapWithConcurrency(
            missingIds.slice(0, 200),
            3,
            async (id) => {
              try {
                return {
                  id,
                  series: await calendarQueue.run(() => api.getSeriesById(id)),
                };
              } catch {
                missingSeries = true;
                return undefined;
              }
            }
          );
          if (missingSeries)
            partialSources.push({
              source,
              ...(isAdmin ? { serverId: server.id } : {}),
            });
          const byId = new Map(
            series.flatMap((item) =>
              item ? [[item.id, item.series] as const] : []
            )
          );
          for (const row of rows)
            if (
              row &&
              typeof row === 'object' &&
              !(
                'series' in row &&
                row.series &&
                typeof row.series === 'object'
              ) &&
              'seriesId' in row
            )
              Object.assign(row, { series: byId.get(row.seriesId as number) });
        }
        return rows.flatMap((row) => {
          const item = normalizeCalendarRow(
            source,
            server.id,
            server.is4k,
            row,
            query.allDayStart,
            query.allDayEnd
          );
          return item &&
            new Date(item.startsAt) >=
              (item.allDay ? query.allDayStart : query.start) &&
            new Date(item.startsAt) <
              (item.allDay ? query.allDayEnd : query.end)
            ? [item]
            : [];
        });
      } catch {
        partialSources.push({
          source,
          ...(isAdmin ? { serverId: server.id } : {}),
        });
        return [];
      }
    }
  );
  let results: ReleaseCalendarItem[] = batches.flat();
  if (query.scope === 'mine') {
    const requests = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoinAndSelect('request.media', 'media')
      .where('request.requestedById = :userId', { userId })
      .andWhere('request.status != :declined', {
        declined: MediaRequestStatus.DECLINED,
      })
      .getMany();
    const tmdbIds = new Set(
      requests.map(
        (request) =>
          `${request.media.mediaType}:${request.media.tmdbId}:${request.is4k}`
      )
    );
    const tvdbIds = new Set(
      requests
        .filter((request) => request.media.tvdbId)
        .map((request) => `${request.media.tvdbId}:${request.is4k}`)
    );
    results = results.filter((item) =>
      item.tmdbId
        ? tmdbIds.has(`${item.mediaType}:${item.tmdbId}:${item.is4k}`)
        : item.mediaType === 'tv' &&
          !!item.tvdbId &&
          tvdbIds.has(`${item.tvdbId}:${item.is4k}`)
    );
  }
  results.sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)
  );
  return {
    results: results.slice(0, 5000),
    partialSources,
    truncated: sourceTruncated || sources.length > 20 || results.length > 5000,
  };
}
