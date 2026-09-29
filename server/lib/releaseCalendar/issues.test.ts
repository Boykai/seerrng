import KapowarrAPI from '@server/api/comics/kapowarr';
import MylarAPI from '@server/api/comics/mylar';
import LazyLibrarianAPI from '@server/api/lazylibrarian';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import {
  getSettings,
  type KapowarrSettings,
  type LazyLibrarianSettings,
  type MylarSettings,
} from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  getComicMagazineReleaseCalendar,
  normalizeIssueReleaseDate,
} from './issues';
import type { CalendarQuery } from './query';

const query = (scope: 'mine' | 'all'): CalendarQuery => ({
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-10-01T00:00:00.000Z'),
  allDayStart: new Date('2026-09-01T00:00:00.000Z'),
  allDayEnd: new Date('2026-10-01T00:00:00.000Z'),
  scope,
  includeUnmonitored: false,
});

const mylarServer = (id: number): MylarSettings =>
  ({
    id,
    name: `Mylar ${id}`,
    hostname: 'localhost',
    port: 8090,
    useSsl: false,
    baseUrl: '',
    apiKey: `mylar-${id}`,
    syncEnabled: true,
  }) as MylarSettings;

const kapowarrServer = (id: number): KapowarrSettings =>
  ({
    id,
    name: `Kapowarr ${id}`,
    hostname: 'localhost',
    port: 5656,
    useSsl: false,
    baseUrl: '',
    apiKey: `kapowarr-${id}`,
    syncEnabled: true,
  }) as KapowarrSettings;

const lazyLibrarianServer = (id: number): LazyLibrarianSettings =>
  ({
    id,
    name: `LazyLibrarian ${id}`,
    hostname: 'localhost',
    port: 5299,
    useSsl: false,
    baseUrl: '',
    apiKey: `lazylibrarian-${id}`,
    syncEnabled: true,
  }) as LazyLibrarianSettings;

const requestedMedia = (
  media: Media,
  serviceType: 'mylar' | 'kapowarr' | 'lazylibrarian',
  serverId: number
) =>
  new MediaRequest({
    type:
      media.mediaType === MediaType.MAGAZINE
        ? MediaType.MAGAZINE
        : MediaType.COMIC,
    media,
    status: MediaRequestStatus.APPROVED,
    is4k: false,
    serverId,
    serviceTargets: [
      {
        serviceType,
        format: serviceType === 'lazylibrarian' ? 'magazine' : 'comic',
        serverId,
      },
    ],
  });

afterEach(() => {
  mock.restoreAll();
  getSettings().mylar = [];
  getSettings().kapowarr = [];
  getSettings().lazylibrarian = [];
});

it('accepts exact issue dates and rejects incomplete or impossible dates', () => {
  assert.equal(
    normalizeIssueReleaseDate('2026-09-18'),
    '2026-09-18T00:00:00.000Z'
  );
  assert.equal(normalizeIssueReleaseDate('2026-09'), undefined);
  assert.equal(normalizeIssueReleaseDate('2026-02-30'), undefined);
});

it('keeps personal comic and magazine issue lookups on each saved request target', async () => {
  const mylar = mylarServer(4);
  const lazyLibrarian = lazyLibrarianServer(5);
  getSettings().mylar = [mylar];
  getSettings().lazylibrarian = [lazyLibrarian];
  getSettings().kapowarr = [];

  const comic = new Media({
    mediaType: MediaType.COMIC,
    tmdbId: 0,
    comicServiceType: 'kapowarr',
    identifiers: [
      new MediaIdentifier({
        provider: MediaIdentifierProvider.COMICVINE,
        value: '1200',
        canonical: true,
      }),
    ],
  });
  const magazine = new Media({
    mediaType: MediaType.MAGAZINE,
    tmdbId: 0,
    externalServiceSlug: 'The Economist',
    identifiers: [
      new MediaIdentifier({
        provider: MediaIdentifierProvider.LAZYLIBRARIAN,
        value: 'the economist',
        canonical: true,
      }),
    ],
  });

  const comicLookup = mock.method(
    MylarAPI.prototype,
    'getComic',
    async (comicId: string) => ({
      comic: { id: comicId, name: 'Batman' },
      issues: [
        {
          id: 'issue-1',
          number: '1',
          releaseDate: '2026-09-15',
          status: 'Downloaded',
        },
        { id: 'issue-2', number: '2', issueDate: '2026-09' },
      ],
    })
  );
  const magazineLookup = mock.method(
    LazyLibrarianAPI.prototype,
    'getIssues',
    async (title: string) => ({
      magazine: { title },
      issues: [
        {
          issueId: 'issue-18',
          title,
          issueNumber: '18 Sep',
          issueDate: '2026-09-18',
          issueFile: 'The_Economist_2026-09-18.pdf',
        },
      ],
    })
  );

  const result = await getComicMagazineReleaseCalendar(query('mine'), [
    requestedMedia(comic, 'mylar', mylar.id),
    requestedMedia(magazine, 'lazylibrarian', lazyLibrarian.id),
  ]);

  assert.deepEqual(
    result.results.map((item) => [item.mediaType, item.title, item.startsAt]),
    [
      ['comic', 'Batman #1', '2026-09-15T00:00:00.000Z'],
      ['magazine', 'The Economist #18 Sep', '2026-09-18T00:00:00.000Z'],
    ]
  );
  assert.equal(result.results[0].available, true);
  assert.equal(result.results[1].available, true);
  assert.equal(
    result.results.every((item) => item.allDay),
    true
  );
  assert.equal(comicLookup.mock.calls[0].arguments[0], '1200');
  assert.equal(magazineLookup.mock.calls[0].arguments[0], 'The Economist');
});

it('omits provider server identifiers from non-admin personal issue status', async () => {
  const comic = new Media({
    mediaType: MediaType.COMIC,
    tmdbId: 0,
    comicServiceType: 'mylar',
  });
  const request = requestedMedia(comic, 'mylar', 17);

  const userResult = await getComicMagazineReleaseCalendar(query('mine'), [
    request,
  ]);
  const adminResult = await getComicMagazineReleaseCalendar(
    query('mine'),
    [request],
    true
  );

  assert.deepEqual(userResult.partialSources, [{ source: 'mylar' }]);
  assert.deepEqual(adminResult.partialSources, [
    { source: 'mylar', serverId: 17 },
  ]);
});

it('stops reading issue details at the event cap and marks the result truncated', async () => {
  const mylar = mylarServer(18);
  getSettings().mylar = [mylar];
  const comic = new Media({
    mediaType: MediaType.COMIC,
    tmdbId: 0,
    comicServiceType: 'mylar',
    identifiers: [
      new MediaIdentifier({
        provider: MediaIdentifierProvider.COMICVINE,
        value: '1800',
        canonical: true,
      }),
    ],
  });
  const issues = Array.from({ length: 6_000 }, (_, index) => ({
    id: `issue-${index}`,
    number: String(index + 1),
    releaseDate: '2026-09-15',
  }));
  let issueReads = 0;
  const boundedIssues = new Proxy(issues, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property))
        issueReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  mock.method(MylarAPI.prototype, 'getComic', async (comicId: string) => ({
    comic: { id: comicId, name: 'Bounded Comic' },
    issues: boundedIssues,
  }));

  const result = await getComicMagazineReleaseCalendar(query('mine'), [
    requestedMedia(comic, 'mylar', mylar.id),
  ]);

  assert.equal(result.results.length, 5_000);
  assert.equal(result.results.at(-1)?.title, 'Bounded Comic #5000');
  assert.equal(result.truncated, true);
  assert.equal(issueReads, 5_001);
});

it('shows monitored Mylar, Kapowarr and LazyLibrarian issue dates in shared scope', async () => {
  const mylar = mylarServer(14);
  const kapowarr = kapowarrServer(15);
  const lazyLibrarian = lazyLibrarianServer(16);
  getSettings().mylar = [mylar];
  getSettings().kapowarr = [kapowarr];
  getSettings().lazylibrarian = [lazyLibrarian];

  mock.method(MylarAPI.prototype, 'getIndex', async () => [
    { id: '1400', name: 'Monitored Comic', status: 'Active' },
    { id: '1401', name: 'Paused Comic', status: 'Paused' },
  ]);
  mock.method(MylarAPI.prototype, 'getComic', async (comicId: string) => ({
    comic: {
      id: comicId,
      name: comicId === '1400' ? 'Monitored Comic' : 'Paused Comic',
    },
    issues: [{ id: 'mylar-issue', number: '2', releaseDate: '2026-09-12' }],
  }));
  mock.method(KapowarrAPI.prototype, 'getVolumes', async () => [
    {
      id: 15,
      comicvine_id: 1500,
      title: 'Kapowarr Comic',
      monitored: true,
      issue_count: 1,
      issues_downloaded: 0,
    },
    {
      id: 16,
      comicvine_id: 1600,
      title: 'Unmonitored Comic',
      monitored: false,
      issue_count: 1,
      issues_downloaded: 0,
    },
  ]);
  mock.method(KapowarrAPI.prototype, 'getVolume', async (id: number) => ({
    id,
    comicvine_id: 1500,
    title: 'Kapowarr Comic',
    monitored: true,
    issue_count: 1,
    issues_downloaded: 0,
    issues: [
      {
        id: 15,
        volume_id: id,
        issue_number: '7',
        title: 'The Red Fist',
        releaseDate: '2026-09-22',
        files: [{ id: 1, filepath: '/comics/issue-7.cbz', size: 1 }],
      },
    ],
  }));
  mock.method(LazyLibrarianAPI.prototype, 'getMagazines', async () => [
    { title: 'Active Magazine', status: 'Active' },
    { title: 'Paused Magazine', status: 'Paused' },
  ]);
  mock.method(
    LazyLibrarianAPI.prototype,
    'getIssues',
    async (title: string) => ({
      magazine: { title },
      issues: [
        {
          issueId: `issue-${title}`,
          title,
          issueNumber: 'September',
          issueDate: '2026-09-19',
        },
      ],
    })
  );

  const result = await getComicMagazineReleaseCalendar(query('all'), []);

  assert.deepEqual(
    result.results.map((item) => item.title),
    ['Monitored Comic #2', 'Kapowarr Comic #7', 'Active Magazine #September']
  );
  assert.equal(
    result.results.find((item) => item.source === 'kapowarr')?.available,
    true
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.partialSources, []);
});

it('keeps issue event order stable when provider responses complete out of order', async () => {
  const first = mylarServer(81);
  const second = mylarServer(82);
  getSettings().mylar = [first, second];
  getSettings().kapowarr = [];
  getSettings().lazylibrarian = [];

  mock.method(MylarAPI.prototype, 'getComic', async (comicId: string) => {
    if (comicId === '8100')
      await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      comic: { id: comicId, name: `Comic ${comicId}` },
      issues: [
        {
          id: `issue-${comicId}`,
          number: '1',
          releaseDate: '2026-09-12',
        },
      ],
    };
  });

  const requests = [
    requestedMedia(
      new Media({
        mediaType: MediaType.COMIC,
        tmdbId: 0,
        comicServiceType: 'mylar',
        externalServiceSlug: '8100',
      }),
      'mylar',
      first.id
    ),
    requestedMedia(
      new Media({
        mediaType: MediaType.COMIC,
        tmdbId: 0,
        comicServiceType: 'mylar',
        externalServiceSlug: '8200',
      }),
      'mylar',
      second.id
    ),
  ];

  const result = await getComicMagazineReleaseCalendar(query('mine'), requests);

  assert.deepEqual(
    result.results.map((item) => item.title),
    ['Comic 8100 #1', 'Comic 8200 #1']
  );
});
