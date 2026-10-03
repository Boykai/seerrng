import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { MangaBindingState } from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  createMangaMedia,
  decideMangaStatus,
  findMangaMedia,
  findMediaWithActiveRequests,
  getMangaAdmissionKey,
  type MangaBindingSummary,
} from '@server/lib/mangaMedia';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const binding = (
  instanceId: number,
  availability: MediaStatus,
  overrides: Partial<MangaBindingSummary> = {}
): MangaBindingSummary => ({
  instanceId,
  state: MangaBindingState.ACTIVE,
  inLibrary: true,
  availability,
  ...overrides,
});

const decide = (
  current: MediaStatus | undefined,
  bindings: MangaBindingSummary[],
  { completed = [1, 2], activeRequest = false } = {}
) =>
  decideMangaStatus({
    current,
    bindings,
    completedInstanceIds: new Set(completed),
    activeRequest,
  });

const { AVAILABLE, PARTIALLY_AVAILABLE, UNKNOWN } = MediaStatus;

describe('decideMangaStatus', () => {
  it('creates media only to record availability', () => {
    assert.equal(decide(undefined, [binding(1, AVAILABLE)]), AVAILABLE);
    assert.equal(
      decide(undefined, [binding(1, PARTIALLY_AVAILABLE)]),
      PARTIALLY_AVAILABLE
    );
    assert.equal(decide(undefined, [binding(1, UNKNOWN)]), undefined);
    assert.equal(decide(undefined, []), undefined);
  });

  it('upgrades any lower status and never touches BLOCKLISTED', () => {
    for (const current of [
      UNKNOWN,
      MediaStatus.PENDING,
      MediaStatus.PROCESSING,
      MediaStatus.DELETED,
      PARTIALLY_AVAILABLE,
    ]) {
      assert.equal(decide(current, [binding(1, AVAILABLE)]), AVAILABLE);
    }
    assert.equal(
      decide(MediaStatus.BLOCKLISTED, [binding(1, AVAILABLE)]),
      undefined
    );
    assert.equal(decide(MediaStatus.BLOCKLISTED, []), undefined);
  });

  it('takes the best in-library binding and leaves an equal rank alone', () => {
    const bindings = [binding(1, PARTIALLY_AVAILABLE), binding(2, AVAILABLE)];
    assert.equal(decide(UNKNOWN, bindings), AVAILABLE);
    assert.equal(decide(AVAILABLE, bindings), undefined);
    assert.equal(decide(MediaStatus.PENDING, [binding(1, UNKNOWN)]), undefined);
    assert.equal(
      decide(UNKNOWN, [
        binding(1, AVAILABLE, { state: MangaBindingState.ORPHANED }),
        binding(2, AVAILABLE, { state: MangaBindingState.REJECTED }),
        binding(1, AVAILABLE, { inLibrary: false }),
      ]),
      undefined
    );
  });

  it('downgrades to the target, with UNKNOWN as the floor', () => {
    assert.equal(
      decide(AVAILABLE, [binding(1, PARTIALLY_AVAILABLE)]),
      PARTIALLY_AVAILABLE
    );
    assert.equal(decide(AVAILABLE, [binding(1, UNKNOWN)]), UNKNOWN);
    assert.equal(decide(PARTIALLY_AVAILABLE, []), UNKNOWN);
  });

  it('holds a downgrade for an active request or an unfinished instance', () => {
    assert.equal(decide(AVAILABLE, [], { activeRequest: true }), undefined);
    const elsewhere = [binding(1, UNKNOWN), binding(3, AVAILABLE)];
    assert.equal(decide(AVAILABLE, elsewhere), undefined);
    assert.equal(
      decide(UNKNOWN, [binding(1, PARTIALLY_AVAILABLE), binding(3, UNKNOWN)]),
      PARTIALLY_AVAILABLE
    );
    // Removed-instance orphaning runs with no completed instance.
    assert.equal(decide(AVAILABLE, [], { completed: [] }), UNKNOWN);
    assert.equal(
      decide(AVAILABLE, [binding(3, AVAILABLE)], { completed: [] }),
      undefined
    );
  });
});

describe('manga media helpers', () => {
  it('builds the request admission key from the AniList ID', () => {
    assert.equal(
      getMangaAdmissionKey(4242),
      'request-canonical:manga:anilist:4242'
    );
  });

  it('creates manga media under its canonical AniList identity', async () => {
    const created = await createMangaMedia(
      dataSource.manager,
      4242,
      PARTIALLY_AVAILABLE
    );
    const media = await getRepository(Media).findOneByOrFail({
      id: created.id,
    });
    assert.equal(media.mediaType, MediaType.MANGA);
    assert.equal(media.status, PARTIALLY_AVAILABLE);
    assert.equal(media.status4k, UNKNOWN);
    assert.ok(media.mediaAddedAt instanceof Date);
    const identifier = await getRepository(MediaIdentifier).findOneOrFail({
      where: { provider: MediaIdentifierProvider.ANILIST, value: '4242' },
      relations: { media: true },
    });
    assert.equal(identifier.canonical, true);
    assert.equal(identifier.media.id, created.id);
  });

  it('finds manga media and flags an AniList ID held by another type', async () => {
    const manga = await createMangaMedia(dataSource.manager, 11, AVAILABLE);
    const other = await getRepository(Media).save(
      new Media({ mediaType: MediaType.TV, tmdbId: 9_001 })
    );
    await getRepository(MediaIdentifier).save(
      new MediaIdentifier({
        media: other,
        provider: MediaIdentifierProvider.ANILIST,
        value: '12',
        canonical: true,
      })
    );

    const found = await findMangaMedia(dataSource.manager, [11, 12, 13]);

    assert.equal(found.get(11)?.id, manga.id);
    assert.equal(found.get(12), null);
    assert.equal(found.has(13), false);
  });

  it('counts pending, approved and failed requests as active', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const statuses = [
      MediaRequestStatus.PENDING,
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.FAILED,
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.COMPLETED,
    ];
    const media: Media[] = [];
    for (const [index, status] of statuses.entries()) {
      const item = await createMangaMedia(
        dataSource.manager,
        100 + index,
        UNKNOWN
      );
      media.push(item);
      await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.MANGA,
          media: item,
          requestedBy: user,
          status,
          is4k: false,
        })
      );
    }

    const active = await findMediaWithActiveRequests(
      dataSource.manager,
      media.map(({ id }) => id)
    );

    assert.deepEqual(
      [...active].sort((a, b) => a - b),
      media.slice(0, 3).map(({ id }) => id)
    );
    assert.deepEqual(
      await findMediaWithActiveRequests(dataSource.manager, []),
      new Set()
    );
  });
});
