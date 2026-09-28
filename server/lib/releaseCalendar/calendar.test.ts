import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { getReleaseCalendar } from './index';
import { normalizeCalendarRow } from './normalize';
import { CalendarQueryError, parseCalendarQuery } from './query';
setupTestDb();
afterEach(() => mock.restoreAll());
const range = { start: '2026-09-01', end: '2026-10-01' };
const server = {
  id: 1,
  name: 'test',
  hostname: 'localhost',
  port: 7878,
  useSsl: false,
  baseUrl: '',
  apiKey: 'credential',
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/media',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};
it('validates real dates, bounded ranges, and shared calendar authority', () => {
  assert.equal(parseCalendarQuery(range, false, false).scope, 'mine');
  assert.equal(
    parseCalendarQuery({ ...range, includeUnmonitored: false }, false, false)
      .includeUnmonitored,
    false
  );
  for (const query of [
    { start: '2026-02-30', end: '2026-03-10' },
    { start: '2026-01-01', end: '2026-06-01' },
    { ...range, scope: 'other' },
    { ...range, includeUnmonitored: ['true'] },
  ])
    assert.throws(
      () => parseCalendarQuery(query, true, true),
      (error) => error instanceof CalendarQueryError && error.status === 400
    );
  assert.throws(
    () => parseCalendarQuery({ ...range, scope: 'all' }, false, false),
    (error) => error instanceof CalendarQueryError && error.status === 403
  );
  assert.throws(
    () =>
      parseCalendarQuery({ ...range, includeUnmonitored: true }, true, false),
    (error) => error instanceof CalendarQueryError && error.status === 403
  );
});
it('uses a physical release inside the range when a preferred digital release is outside it', () => {
  const result = normalizeCalendarRow(
    'radarr',
    1,
    false,
    {
      id: 1,
      title: 'Movie',
      tmdbId: 2,
      digitalRelease: '2026-08-01',
      physicalRelease: '2026-09-12',
    },
    new Date('2026-09-01'),
    new Date('2026-10-01')
  );
  assert.equal(result?.dateType, 'physical');
  assert.equal(result?.allDay, true);
});
it('retains Sonarr episode identity and air time while rejecting malformed episodes', () => {
  const episode = {
    id: 11,
    title: 'Episode',
    airDateUtc: '2026-09-12T20:00:00Z',
    seasonNumber: 1,
    episodeNumber: 2,
    series: { title: 'Series', tmdbId: 4, tvdbId: 5 },
    hasFile: true,
  };
  const result = normalizeCalendarRow('sonarr', 1, true, episode);
  assert.equal(result?.available, true);
  assert.equal(result?.episodeNumber, 2);
  assert.equal(result?.allDay, false);
  assert.equal(
    normalizeCalendarRow('sonarr', 1, true, { ...episode, episodeNumber: 0 }),
    undefined
  );
});
it('keeps successful sources when another fails without exposing service identifiers to ordinary users', async () => {
  getSettings().radarr = [
    { ...server, minimumAvailability: 'released' } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      ...server,
      port: 8989,
      seriesType: 'standard',
      animeSeriesType: 'anime',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    } satisfies SonarrSettings,
  ];
  mock.method(RadarrAPI.prototype, 'getReleaseCalendar', async () => [
    {
      id: 1,
      title: 'Movie',
      tmdbId: 2,
      digitalRelease: '2026-09-12',
      hasFile: false,
    },
  ]);
  mock.method(SonarrAPI.prototype, 'getReleaseCalendar', async () => {
    throw new Error('Private upstream error with credential');
  });
  const result = await getReleaseCalendar(
    parseCalendarQuery({ ...range, scope: 'all' }, true, false),
    1,
    false
  );
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.partialSources, [{ source: 'sonarr' }]);
  assert.equal(JSON.stringify(result).includes('credential'), false);
});
it('limits the personal calendar to the current user’s requested titles and quality', async () => {
  getSettings().radarr = [
    { ...server, minimumAvailability: 'released' } as RadarrSettings,
  ];
  getSettings().sonarr = [];
  const user = await getRepository(User).findOneByOrFail({ id: 1 });
  const media = await getRepository(Media).save(
    new Media({ mediaType: MediaType.MOVIE, tmdbId: 2 })
  );
  await getRepository(MediaRequest).save({
    media,
    type: MediaType.MOVIE,
    requestedBy: user,
    is4k: false,
    status: MediaRequestStatus.APPROVED,
  });
  mock.method(RadarrAPI.prototype, 'getReleaseCalendar', async () => [
    {
      id: 1,
      title: 'Requested movie',
      tmdbId: 2,
      digitalRelease: '2026-09-12',
    },
    { id: 2, title: 'Other movie', tmdbId: 3, digitalRelease: '2026-09-13' },
  ]);
  const result = await getReleaseCalendar(
    parseCalendarQuery(range, false, false),
    1,
    false
  );
  assert.deepEqual(
    result.results.map((item) => item.title),
    ['Requested movie']
  );
});

it('uses local month boundaries for episode times and UTC date boundaries for all-day movies', () => {
  const query = parseCalendarQuery(
    { ...range, timeZone: 'America/Regina' },
    true,
    true
  );
  assert.equal(query.start.toISOString(), '2026-09-01T06:00:00.000Z');
  assert.equal(query.end.toISOString(), '2026-10-01T06:00:00.000Z');
  assert.equal(query.allDayStart.toISOString(), '2026-09-01T00:00:00.000Z');
  const dst = parseCalendarQuery(
    { start: '2026-03-01', end: '2026-04-01', timeZone: 'America/New_York' },
    true,
    true
  );
  assert.equal(dst.start.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.equal(dst.end.toISOString(), '2026-04-01T04:00:00.000Z');
  assert.throws(
    () =>
      parseCalendarQuery(
        { ...range, timeZone: 'Unknown/Timezone' },
        true,
        true
      ),
    (error) => error instanceof CalendarQueryError && error.status === 400
  );
});

it('handles a month boundary where daylight saving skips midnight', () => {
  const query = parseCalendarQuery(
    { start: '2014-08-01', end: '2014-09-01', timeZone: 'Africa/Cairo' },
    true,
    true
  );
  assert.equal(query.start.toISOString(), '2014-07-31T22:00:00.000Z');
});
