import AnilistAPI from '@server/api/anilist';
import RadarrAPI from '@server/api/servarr/radarr';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import { graphqlErrors, syntheticFailure } from '@server/test/fakeSuwayomi';
import { serveFakeChapterReleases } from '@server/test/fakeSuwayomiChapterReleases';
import {
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchManga,
  seedDispatchBinding,
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { captureReleaseCalendarHistory } from './history';
import { getReleaseCalendar } from './index';
import { resetMangaReleaseCalendarCache } from './manga';
import { CalendarQueryError, parseCalendarQuery } from './query';

setupTestDb();

const settings = getSettings();
const savedCategories = settings.main.enabledMediaCategories;
const savedRadarr = settings.radarr;
const savedSuwayomi = settings.suwayomi;

// The calendar never reads ahead of now, so the chapter is an hour old.
const releasedAt = Date.now() - 60 * 60 * 1000;
const day = new Date(releasedAt).toISOString().slice(0, 10);
const range = {
  start: day,
  end: new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10),
};

const radarr = {
  id: 1,
  name: 'Calendar Radarr',
  hostname: 'localhost',
  port: 7878,
  useSsl: false,
  baseUrl: '',
  apiKey: 'calendar-test-key',
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
  minimumAvailability: 'released',
} as RadarrSettings;

let fake: FakeDispatchSuwayomi | undefined;
let anilistCalls = 0;

/** A Suwayomi instance with one chapter of a title the friend requested. */
const startSuwayomi = async (): Promise<FakeDispatchSuwayomi> => {
  const manga = fakeDispatchManga(11, {
    chapters: [
      {
        id: 1101,
        url: fakeChapterUrl(11, 1),
        chapterNumber: 1,
        uploadDate: releasedAt,
        isDownloaded: false,
      },
    ],
  });
  fake = await startFakeDispatchSuwayomi([manga]);
  serveFakeChapterReleases(fake);
  invalidateSuwayomiClients();
  settings.suwayomi = [dispatchInstanceFor(fake.server, 1)];
  await seedDispatchBinding(manga, { anilistId: 9101 });
  await seedDispatchRequest({
    anilistId: 9101,
    manifest: {
      bindingSourceId: manga.sourceId,
      bindingUrlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId: manga.id,
    },
  });
  return fake;
};

const reads = (suwayomi: FakeDispatchSuwayomi) =>
  suwayomi.server.operations('ChapterReleases').length;

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...savedCategories, manga: true };
  settings.radarr = [];
  invalidateSuwayomiClients();
  settings.suwayomi = [];
  resetMangaReleaseCalendarCache();
  anilistCalls = 0;
  mock.method(
    AnilistAPI.prototype,
    'getMangaSummariesByIds',
    async (ids: readonly number[]) => {
      anilistCalls += 1;
      return ids.map((id) => ({
        id,
        titles: { english: 'Calendar Manga' },
        synonyms: [],
        format: 'MANGA',
        isAdult: false,
        genres: [],
      }));
    }
  );
});

afterEach(async () => {
  mock.restoreAll();
  settings.main.enabledMediaCategories = savedCategories;
  settings.radarr = savedRadarr;
  invalidateSuwayomiClients();
  settings.suwayomi = savedSuwayomi;
  resetMangaReleaseCalendarCache();
  await fake?.close();
  fake = undefined;
});

describe('manga in the release calendar', () => {
  it('accepts manga as a media type under the existing scope rules', () => {
    assert.equal(
      parseCalendarQuery({ ...range, mediaType: 'manga' }, false, false)
        .mediaType,
      'manga'
    );
    const rejects = (
      query: Record<string, unknown>,
      canViewAll: boolean,
      status: number
    ) =>
      assert.throws(
        () => parseCalendarQuery(query, canViewAll, false),
        (error) =>
          error instanceof CalendarQueryError && error.status === status
      );
    rejects({ ...range, mediaType: 'mangas' }, true, 400);
    rejects({ ...range, mediaType: 'manga', scope: 'all' }, false, 403);
    rejects(
      { ...range, mediaType: 'manga', scope: 'all', includeUnmonitored: true },
      true,
      403
    );
  });

  it('shows the viewer’s requested manga in the personal calendar', async () => {
    const suwayomi = await startSuwayomi();
    const query = parseCalendarQuery(range, false, false);

    const friend = await getReleaseCalendar(query, 2, false);
    assert.deepStrictEqual(
      friend.results.map((item) => ({
        id: item.id,
        source: item.source,
        mediaType: item.mediaType,
        title: item.title,
        startsAt: item.startsAt,
        dateType: item.dateType,
        mangaId: item.mangaId,
        chapterCount: item.chapterCount,
        available: item.available,
      })),
      [
        {
          id: `suwayomi:manga:9101:${day}`,
          source: 'suwayomi',
          mediaType: 'manga',
          title: 'Calendar Manga',
          startsAt: `${day}T00:00:00.000Z`,
          dateType: 'chapter',
          mangaId: 9101,
          chapterCount: 1,
          available: false,
        },
      ]
    );
    assert.deepStrictEqual(friend.partialSources, []);
    assert.equal(friend.truncated, false);

    const other = await getReleaseCalendar(query, 3, false);
    assert.deepStrictEqual(other.results, []);
    assert.equal(reads(suwayomi), 1);
  });

  it('leaves manga out while the manga category is off', async () => {
    const suwayomi = await startSuwayomi();
    settings.main.enabledMediaCategories = {
      ...savedCategories,
      manga: false,
    };

    assert.deepStrictEqual(
      await getReleaseCalendar(
        parseCalendarQuery({ ...range, mediaType: 'manga' }, true, true),
        1,
        true
      ),
      { results: [], partialSources: [], truncated: false }
    );
    assert.deepStrictEqual(
      (
        await getReleaseCalendar(
          parseCalendarQuery({ ...range, scope: 'all' }, true, true),
          1,
          true
        )
      ).results,
      []
    );
    assert.equal(reads(suwayomi), 0);
    assert.equal(anilistCalls, 0);
  });

  it('keeps the other sources when Suwayomi fails and names the server only to administrators', async () => {
    const suwayomi = await startSuwayomi();
    suwayomi.server.onOperation(
      'ChapterReleases',
      graphqlErrors([syntheticFailure()])
    );
    settings.radarr = [radarr];
    mock.method(RadarrAPI.prototype, 'getReleaseCalendar', async () => [
      {
        id: 1,
        title: 'Calendar Movie',
        tmdbId: 2,
        digitalRelease: day,
        hasFile: false,
      },
    ]);

    const viewer = await getReleaseCalendar(
      parseCalendarQuery({ ...range, scope: 'all' }, true, false),
      2,
      false
    );
    assert.deepStrictEqual(
      viewer.results.map((item) => [item.source, item.title]),
      [['radarr', 'Calendar Movie']]
    );
    assert.deepStrictEqual(viewer.partialSources, [{ source: 'suwayomi' }]);

    const admin = await getReleaseCalendar(
      parseCalendarQuery({ ...range, scope: 'all' }, true, true),
      1,
      true
    );
    assert.deepStrictEqual(
      admin.results.map((item) => item.source),
      ['radarr']
    );
    assert.deepStrictEqual(admin.partialSources, [
      { source: 'suwayomi', serverId: 1 },
    ]);
  });

  it('leaves manga out of the daily release history', async () => {
    const suwayomi = await startSuwayomi();

    await captureReleaseCalendarHistory();

    assert.equal(reads(suwayomi), 0);
    assert.equal(anilistCalls, 0);
  });
});
