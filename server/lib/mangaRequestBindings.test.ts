import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  hasActiveMangaBinding,
  syncMangaRequestBindings,
} from '@server/lib/mangaRequestBindings';
import { DEFAULT_MANGA_REQUEST_SCOPE } from '@server/lib/mangaRequests';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const { AWAITING_BINDING, BOUND } = MangaRequestBindingState;

const seedManifest = async (
  anilistId: number,
  instanceId: number,
  overrides: Partial<MangaRequestManifest> = {}
): Promise<MangaRequestManifest> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 0,
      mediaType: MediaType.MANGA,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MANGA,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      serverId: instanceId,
    })
  );
  return getRepository(MangaRequestManifest).save(
    new MangaRequestManifest({
      requestId: request.id,
      anilistId,
      instanceId,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
      ...overrides,
    })
  );
};

const seedBinding = (
  anilistId: number,
  instanceId: number,
  state = MangaBindingState.ACTIVE,
  url = `/manga/${anilistId}`
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId,
      sourceId: '1000',
      url,
      urlHash: hashMangaSourceUrl(url),
      anilistId,
      suwayomiMangaId: 1,
      title: 'Sample Manga',
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state,
      inLibrary: state === MangaBindingState.ACTIVE,
    })
  );

const stateOf = async (manifest: MangaRequestManifest) => {
  const { bindingState, boundAt } = await getRepository(
    MangaRequestManifest
  ).findOneByOrFail({ id: manifest.id });
  return { bindingState, bound: boundAt instanceof Date };
};

describe('hasActiveMangaBinding', () => {
  it('counts only an ACTIVE binding of the title on the instance', async () => {
    await seedBinding(900001, 1);
    await seedBinding(900002, 1, MangaBindingState.ORPHANED);
    await seedBinding(900003, 1, MangaBindingState.REJECTED);

    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900001, 1),
      true
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900001, 2),
      false
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900002, 1),
      false
    );
    assert.strictEqual(
      await hasActiveMangaBinding(dataSource.manager, 900003, 1),
      false
    );
  });
});

describe('syncMangaRequestBindings', () => {
  it('releases a parked request once its binding appears, and parks it again when it goes', async () => {
    const parked = await seedManifest(900001, 1);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });

    // A binding on another instance doesn't release it.
    const elsewhere = await seedBinding(900001, 2, MangaBindingState.ACTIVE);
    await syncMangaRequestBindings(dataSource.manager);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });

    const binding = await seedBinding(
      900001,
      1,
      MangaBindingState.ACTIVE,
      '/b'
    );
    await syncMangaRequestBindings(dataSource.manager, [900001]);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: BOUND,
      bound: true,
    });

    await getRepository(MangaSourceBinding).update(binding.id, {
      state: MangaBindingState.ORPHANED,
      inLibrary: false,
    });
    await syncMangaRequestBindings(dataSource.manager, [900001]);
    assert.deepStrictEqual(await stateOf(parked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });
    assert.ok(elsewhere.id);
  });

  it('touches only the listed titles', async () => {
    const listed = await seedManifest(900001, 1);
    const unlisted = await seedManifest(900002, 1);
    await seedBinding(900001, 1);
    await seedBinding(900002, 1, MangaBindingState.ACTIVE, '/other');

    await syncMangaRequestBindings(dataSource.manager, [900001, 900001]);

    assert.strictEqual((await stateOf(listed)).bindingState, BOUND);
    assert.strictEqual(
      (await stateOf(unlisted)).bindingState,
      AWAITING_BINDING
    );

    await syncMangaRequestBindings(dataSource.manager, []);
    assert.strictEqual(
      (await stateOf(unlisted)).bindingState,
      AWAITING_BINDING
    );

    await syncMangaRequestBindings(dataSource.manager);
    assert.strictEqual((await stateOf(unlisted)).bindingState, BOUND);
  });

  it('leaves frozen manifests to the dispatcher', async () => {
    const frozenParked = await seedManifest(900001, 1, {
      frozenAt: new Date(),
    });
    const frozenBound = await seedManifest(900002, 1, {
      frozenAt: new Date(),
      bindingState: BOUND,
      boundAt: new Date(),
    });
    await seedBinding(900001, 1);

    await syncMangaRequestBindings(dataSource.manager);

    assert.deepStrictEqual(await stateOf(frozenParked), {
      bindingState: AWAITING_BINDING,
      bound: false,
    });
    assert.deepStrictEqual(await stateOf(frozenBound), {
      bindingState: BOUND,
      bound: true,
    });
  });

  it('syncs more titles than one statement carries', async () => {
    const manifest = await seedManifest(900001, 1);
    await seedBinding(900001, 1);
    const ids = [
      ...Array.from({ length: 600 }, (_, index) => 800_000 + index),
      900001,
    ];

    await syncMangaRequestBindings(dataSource.manager, ids);

    assert.strictEqual((await stateOf(manifest)).bindingState, BOUND);
  });

  it('runs on the caller transaction and never enqueues dispatch', async () => {
    const manifest = await seedManifest(900001, 1);

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.save(
          new MangaSourceBinding({
            instanceId: 1,
            sourceId: '1000',
            url: '/manga/tx',
            urlHash: hashMangaSourceUrl('/manga/tx'),
            anilistId: 900001,
            suwayomiMangaId: 1,
            title: 'Sample Manga',
            confidence: MangaBindingConfidence.MANUAL,
            matchedBy: 'manual',
            origin: 'admin',
            state: MangaBindingState.ACTIVE,
            inLibrary: true,
          })
        );
        await syncMangaRequestBindings(manager, [900001]);
        assert.strictEqual(
          (
            await manager.findOneByOrFail(MangaRequestManifest, {
              id: manifest.id,
            })
          ).bindingState,
          BOUND
        );
        throw new Error('force rollback');
      }),
      /force rollback/
    );

    assert.strictEqual(
      (await stateOf(manifest)).bindingState,
      AWAITING_BINDING
    );
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: manifest.requestId,
        })
      ).status,
      MediaRequestStatus.PENDING
    );
  });
});
