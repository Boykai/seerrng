import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import ExternalAPI from '@server/api/externalapi';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
  hasMediaRequestPermission,
} from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

// get is a prototype method unlike getMovie, and replaces the cache lookup too
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      seasons: [1, 2, 3].map((season_number) => ({ season_number })),
      // Skips getMovie's localized fallback call
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

beforeEach(() => {
  externalApiGetMock.resetCalls();
});

async function seedRequester(movieQuotaLimit: number): Promise<User> {
  const userRepository = getRepository(User);

  const requester = await userRepository.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  requester.movieQuotaLimit = movieQuotaLimit;

  return userRepository.save(requester);
}

async function createRequester(
  email: string,
  permissions = Permission.REQUEST
): Promise<User> {
  return getRepository(User).save(new User({ email, permissions, avatar: '' }));
}

function requestMovies(mediaIds: number[], requester: User) {
  return Promise.allSettled(
    mediaIds.map((mediaId) =>
      MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false },
        requester
      )
    )
  );
}

function rejections(results: PromiseSettledResult<MediaRequest>[]) {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
}

describe('MediaRequest.request', () => {
  it('rejects the second of two concurrent requests at the movie quota', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(1);

    const results = await requestMovies([11111, 22222], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof QuotaRestrictedError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 1);
  });

  it('rejects a concurrent duplicate request for the same movie', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const results = await requestMovies([33333, 33333], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 2);
  });

  it('rejects a duplicate request that omits is4k', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const body = { mediaId: 66666, mediaType: MediaType.MOVIE };

    await MediaRequest.request(body, requester);

    await assert.rejects(
      () => MediaRequest.request(body, requester),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('rejects a concurrent duplicate request from a different user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [requester, otherRequester].map((user) =>
        MediaRequest.request(
          { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
          user
        )
      )
    );
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('gives an overlapping season to only one of two concurrent users', async () => {
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [
        [requester, [1, 2]],
        [otherRequester, [2, 3]],
      ].map(([user, seasons]) =>
        MediaRequest.request(
          {
            mediaId: 55555,
            mediaType: MediaType.TV,
            seasons: seasons as number[],
            is4k: false,
          },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      1
    );
    assert.strictEqual(await seasonRequestRepository.count(), 3);
  });

  it('creates one media row for concurrent 4k and non-4k requests', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester(
      'second@seerr.dev',
      Permission.REQUEST_4K
    );

    const results = await Promise.allSettled(
      [
        [requester, false],
        [otherRequester, true],
      ].map(([user, is4k]) =>
        MediaRequest.request(
          { mediaId: 88888, mediaType: MediaType.MOVIE, is4k: is4k as boolean },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(
      await mediaRepository.count({
        where: { tmdbId: 88888, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });

  it('records manga requests without a TMDB lookup or a 4K variant', async (t) => {
    const settings = getSettings();
    const savedSuwayomi = settings.suwayomi;
    settings.suwayomi = [
      {
        id: 1,
        name: 'Suwayomi',
        hostname: 'localhost',
        port: 4567,
        useSsl: false,
        baseUrl: '',
        isDefault: true,
        authMode: 'NONE',
        username: '',
        password: '',
        sourceAllowlist: [],
        preferredLanguages: [],
        scanlatorPreference: [],
        requireCbz: true,
      },
    ];
    t.after(() => {
      settings.suwayomi = savedSuwayomi;
    });
    const anilist = mock.method(
      AnilistAPI.prototype,
      'getMangaDetails',
      async (id: number) => ({
        id,
        titles: { english: 'Sample Manga' },
        synonyms: [],
        format: 'MANGA',
        isAdult: false,
        genres: [],
        tags: [],
        staff: [],
      })
    );
    t.after(() => anilist.mock.restore());
    const requester = await createRequester(
      'manga@seerr.dev',
      Permission.REQUEST + Permission.REQUEST_MANGA
    );

    const request = await MediaRequest.request(
      { mediaId: 12345, mediaType: MediaType.MANGA, is4k: true },
      requester
    );

    assert.strictEqual(request.type, MediaType.MANGA);
    assert.strictEqual(request.is4k, false);
    assert.strictEqual(await getRepository(MediaRequest).count(), 1);
    assert.strictEqual(anilist.mock.callCount(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 0);
  });
});

describe('hasMediaRequestPermission', () => {
  const userWith = (permissions: number) =>
    new User({ email: 'permissions@seerr.dev', permissions, avatar: '' });

  it('allows manga requests with the general or the manga request permission', () => {
    assert.strictEqual(
      hasMediaRequestPermission(userWith(Permission.REQUEST), MediaType.MANGA),
      true
    );
    assert.strictEqual(
      hasMediaRequestPermission(
        userWith(Permission.REQUEST_MANGA),
        MediaType.MANGA
      ),
      true
    );
    assert.strictEqual(
      hasMediaRequestPermission(userWith(Permission.ADMIN), MediaType.MANGA),
      true
    );
  });

  it('keeps the manga and book request permissions separate', () => {
    assert.strictEqual(
      hasMediaRequestPermission(
        userWith(Permission.REQUEST_BOOK + Permission.REQUEST_COMIC),
        MediaType.MANGA
      ),
      false
    );
    assert.strictEqual(
      hasMediaRequestPermission(
        userWith(Permission.REQUEST_MANGA),
        MediaType.BOOK
      ),
      false
    );
    assert.strictEqual(
      hasMediaRequestPermission(userWith(Permission.NONE), MediaType.MANGA),
      false
    );
  });
});
