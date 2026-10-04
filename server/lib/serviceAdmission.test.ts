import { runWithRequestAdmission } from '@server/entity/MediaRequest';
import requestAdmissionCoordinator, {
  RequestAdmissionCoordinator,
} from '@server/lib/requestAdmission';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import type { DataSource, QueryRunner } from 'typeorm';

import {
  ServarrServiceAuthorityChangedError,
  getServarrServiceAdmissionResource,
  getServarrServiceCollectionAdmissionResource,
  hasSameServarrServiceAuthority,
  runWithCurrentServarrService,
  runWithServarrServiceAdmission,
  runWithServarrServiceCollectionAdmission,
  runWithServarrServiceCollectionMutationAdmission,
  runWithServarrServiceMutationAdmission,
  runWithServarrServiceSnapshot,
  runWithServarrServiceSnapshots,
} from './serviceAdmission';
import { getSettings, type SuwayomiSettings } from './settings';

describe('Servarr service admission', () => {
  it('serializes matching service lifecycles and allows unrelated services', async () => {
    let releaseFirst!: () => void;
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let matchingEntered = false;
    let unrelatedEntered = false;
    let unrelatedSameTypeEntered = false;

    const first = runWithServarrServiceAdmission(
      [{ serviceType: 'radarr', serviceId: 0 }],
      async () => {
        firstEntered();
        await releaseFirstPromise;
      }
    );
    await firstEnteredPromise;
    const matching = runWithServarrServiceAdmission(
      [{ serviceType: 'radarr', serviceId: 0 }],
      async () => {
        matchingEntered = true;
      }
    );
    const unrelated = runWithServarrServiceAdmission(
      [{ serviceType: 'sonarr', serviceId: 0 }],
      async () => {
        unrelatedEntered = true;
      }
    );
    const unrelatedSameType = runWithServarrServiceAdmission(
      [{ serviceType: 'radarr', serviceId: 1 }],
      async () => {
        unrelatedSameTypeEntered = true;
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(matchingEntered, false);
    assert.strictEqual(unrelatedEntered, true);
    assert.strictEqual(unrelatedSameTypeEntered, true);
    releaseFirst();
    await Promise.all([first, matching, unrelated, unrelatedSameType]);
    assert.strictEqual(matchingEntered, true);
  });

  it('serializes collection mutations with exact family admission', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let mutationEntered = false;
    const collection = runWithServarrServiceCollectionAdmission(
      'radarr',
      async () => {
        entered();
        await held;
      }
    );
    await enteredPromise;
    const mutation = runWithServarrServiceMutationAdmission(
      [{ serviceType: 'radarr', serviceId: 1 }],
      async () => {
        mutationEntered = true;
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(mutationEntered, false);
    release();
    await Promise.all([collection, mutation]);
    assert.strictEqual(mutationEntered, true);
  });

  it('protects every current instance during collection-wide mutations', async () => {
    const settings = getSettings();
    const previous = settings.radarr;
    settings.radarr = [
      {
        id: 20,
        name: 'First',
        hostname: 'first.local',
        port: 7878,
        apiKey: 'first-key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'HD',
        activeDirectory: '/movies',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        minimumAvailability: 'released',
      },
      {
        id: 21,
        name: 'Second',
        hostname: 'second.local',
        port: 7878,
        apiKey: 'second-key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'HD',
        activeDirectory: '/movies-2',
        tags: [],
        is4k: false,
        isDefault: false,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        minimumAvailability: 'released',
      },
    ];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderEntered!: () => void;
    const holderEnteredPromise = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    let mutationEntered = false;

    try {
      const holder = runWithServarrServiceAdmission(
        [{ serviceType: 'radarr', serviceId: 21 }],
        async () => {
          holderEntered();
          await held;
        }
      );
      await holderEnteredPromise;
      const mutation = runWithServarrServiceCollectionMutationAdmission(
        'radarr',
        async () => {
          mutationEntered = true;
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(mutationEntered, false);

      release();
      await Promise.all([holder, mutation]);
      assert.strictEqual(mutationEntered, true);
    } finally {
      settings.radarr = previous;
    }
  });

  it('rejects invalid service IDs before invoking callbacks', () => {
    let invoked = false;
    assert.throws(
      () =>
        runWithServarrServiceAdmission(
          [{ serviceType: 'radarr', serviceId: Number.NaN }],
          async () => {
            invoked = true;
          }
        ),
      /valid service ID/i
    );
    assert.strictEqual(invoked, false);
    assert.strictEqual(
      getServarrServiceAdmissionResource('lidarr', 0),
      'service-config:lidarr:0'
    );
  });

  it('resolves service configuration only after admission', async () => {
    const settings = getSettings();
    const previous = settings.radarr;
    settings.radarr = [
      {
        id: 9,
        name: 'Initial',
        hostname: 'initial.local',
        port: 7878,
        apiKey: 'initial-key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'HD',
        activeDirectory: '/movies',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        minimumAvailability: 'released',
      },
    ];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    try {
      const holder = runWithServarrServiceAdmission(
        [{ serviceType: 'radarr', serviceId: 9 }],
        async () => {
          entered();
          await held;
        }
      );
      await enteredPromise;
      const result = runWithCurrentServarrService(
        'radarr',
        9,
        async (service) => service.apiKey
      );
      settings.radarr = [{ ...settings.radarr[0], apiKey: 'rotated-key' }];
      release();

      assert.strictEqual(await result, 'rotated-key');
      await holder;
    } finally {
      settings.radarr = previous;
    }
  });

  it('rejects immutable service snapshots after authority changes', async () => {
    const settings = getSettings();
    const previous = settings.radarr;
    const snapshot = {
      id: 11,
      name: 'Snapshot',
      hostname: 'snapshot.local',
      port: 7878,
      apiKey: 'first-key',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'HD',
      activeDirectory: '/movies',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    };
    settings.radarr = [{ ...snapshot, apiKey: 'rotated-key' }];

    try {
      await assert.rejects(
        runWithServarrServiceSnapshot('radarr', snapshot, async () => true),
        ServarrServiceAuthorityChangedError
      );
    } finally {
      settings.radarr = previous;
    }
  });

  it('treats a missing legacy quality flag as the standard tier', async () => {
    const settings = getSettings();
    const previous = settings.radarr;
    const snapshot = {
      id: 14,
      name: 'Legacy standard',
      hostname: 'legacy.local',
      port: 7878,
      apiKey: 'legacy-key',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'HD',
      activeDirectory: '/movies',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    };
    const legacySettings = { ...snapshot };
    Reflect.deleteProperty(legacySettings, 'is4k');
    settings.radarr = [legacySettings];

    try {
      assert.strictEqual(
        await runWithServarrServiceSnapshot(
          'radarr',
          snapshot,
          async (service) => service.apiKey
        ),
        'legacy-key'
      );
    } finally {
      settings.radarr = previous;
    }
  });

  it('rejects exact authority sets when a new active service is added', async () => {
    const settings = getSettings();
    const previous = settings.radarr;
    const snapshot = {
      id: 12,
      name: 'Snapshot',
      hostname: 'snapshot.local',
      port: 7878,
      apiKey: 'first-key',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'HD',
      activeDirectory: '/movies',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    };
    settings.radarr = [
      snapshot,
      { ...snapshot, id: 13, name: 'Added', isDefault: false },
    ];

    try {
      await assert.rejects(
        runWithServarrServiceSnapshots('radarr', [snapshot], async () => true, {
          requireExactAuthoritySet: true,
          includeCurrent: (service) => service.syncEnabled,
        }),
        ServarrServiceAuthorityChangedError
      );
    } finally {
      settings.radarr = previous;
    }
  });
});

describe('Suwayomi service admission', () => {
  const suwayomi = (
    overrides: Partial<SuwayomiSettings> = {}
  ): SuwayomiSettings => ({
    id: 0,
    name: 'Suwayomi',
    hostname: 'suwayomi.local',
    port: 4567,
    useSsl: false,
    isDefault: true,
    authMode: 'UI_LOGIN',
    username: 'fake-user',
    password: randomUUID(),
    sourceAllowlist: [],
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
    ...overrides,
  });

  it('uses the shared admission resource names', () => {
    assert.equal(
      getServarrServiceAdmissionResource('suwayomi', 3),
      'service-config:suwayomi:3'
    );
    assert.equal(
      getServarrServiceCollectionAdmissionResource('suwayomi'),
      'service-config:suwayomi:collection'
    );
  });

  it('treats the address and the stored login as the authority', () => {
    const current = suwayomi();
    assert.equal(hasSameServarrServiceAuthority(current, { ...current }), true);
    const renamed: SuwayomiSettings = {
      ...current,
      name: 'Renamed',
      sourceAllowlist: ['4000000000000000001'],
      requireCbz: false,
    };
    assert.equal(hasSameServarrServiceAuthority(current, renamed), true);
    const changes: Partial<SuwayomiSettings>[] = [
      { id: 1 },
      { hostname: 'elsewhere.local' },
      { port: 4568 },
      { useSsl: true },
      { baseUrl: '/manga' },
      { authMode: 'BASIC_AUTH' },
      { username: 'other-user' },
      { password: randomUUID() },
    ];
    for (const change of changes) {
      assert.equal(
        hasSameServarrServiceAuthority(current, { ...current, ...change }),
        false,
        Object.keys(change)[0]
      );
    }
  });

  it('never matches a keyed service with the same address', () => {
    const current = suwayomi();
    const keyed = {
      id: current.id,
      hostname: current.hostname,
      port: current.port,
      useSsl: current.useSsl,
      baseUrl: current.baseUrl,
      apiKey: 'test-key',
      syncEnabled: true,
    };
    assert.equal(hasSameServarrServiceAuthority(current, keyed), false);
    assert.equal(hasSameServarrServiceAuthority(keyed, current), false);
  });

  it('rejects a snapshot after the stored password changes', async () => {
    const settings = getSettings();
    const previous = settings.suwayomi;
    const snapshot = suwayomi();
    settings.suwayomi = [{ ...snapshot, password: randomUUID() }];

    try {
      await assert.rejects(
        runWithServarrServiceSnapshot('suwayomi', snapshot, async () => true),
        ServarrServiceAuthorityChangedError
      );
      settings.suwayomi = [snapshot];
      assert.equal(
        await runWithServarrServiceSnapshot(
          'suwayomi',
          snapshot,
          async (service) => service.id
        ),
        0
      );
    } finally {
      settings.suwayomi = previous;
    }
  });
});

describe('Service admission order', () => {
  const deferred = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  const settleWithin = async <T>(
    work: Promise<T>,
    milliseconds: number
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Admissions still waiting after ${milliseconds} ms`)
          ),
        milliseconds
      );
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  // An enabled coordinator with one connection slot, so every outermost
  // admission shares a slot. Advisory locks never block here; the order of
  // the slot and the in-process locks alone decides whether both finish.
  const useSingleSlotCoordinator = (t: TestContext) => {
    const advisoryKeys: string[] = [];
    let connections = 0;
    const source: Pick<DataSource, 'createQueryRunner'> = {
      createQueryRunner: () => {
        const runner = {
          isTransactionActive: false,
          connect: async () => {
            connections += 1;
          },
          startTransaction: async () => {
            runner.isTransactionActive = true;
          },
          commitTransaction: async () => {
            runner.isTransactionActive = false;
          },
          rollbackTransaction: async () => {
            runner.isTransactionActive = false;
          },
          release: async () => undefined,
          query: async (_sql: string, parameters?: unknown[]) => {
            advisoryKeys.push(String(parameters?.[0]));
            return [];
          },
        };
        return runner as unknown as QueryRunner;
      },
    };
    const coordinator = new RequestAdmissionCoordinator(source, true, 1);
    const run: typeof requestAdmissionCoordinator.run = (keys, callback) =>
      coordinator.run(keys, callback);
    t.mock.method(requestAdmissionCoordinator, 'run', run);
    return { advisoryKeys, connections: () => connections };
  };

  it('lets a request writer enter a service that waits for the same connection slot', async (t) => {
    const database = useSingleSlotCoordinator(t);
    // Keys unique per test: a hung admission would keep its locks forever.
    const titleKey = 'request-canonical:manga:anilist:900001';
    const service = {
      serviceType: 'suwayomi' as const,
      serviceId: 900_000_001,
    };
    const writerAdmitted = deferred();
    const continueWriter = deferred();
    const finished: string[] = [];

    const writer = runWithRequestAdmission([titleKey], async () => {
      writerAdmitted.resolve();
      await continueWriter.promise;
      await runWithServarrServiceAdmission([service], async () => {
        finished.push('writer');
      });
    });
    await writerAdmitted.promise;
    const job = runWithServarrServiceAdmission([service], async () => {
      finished.push('job');
    });
    await nextTurn();
    await nextTurn();
    continueWriter.resolve();

    await settleWithin(Promise.all([writer, job]), 2_000);
    assert.deepEqual(finished, ['writer', 'job']);
    assert.equal(database.connections(), 2);
  });

  it('admits a nested service on the connection of the request admission', async (t) => {
    const database = useSingleSlotCoordinator(t);
    const titleKey = 'request-canonical:manga:anilist:900002';
    const service = {
      serviceType: 'suwayomi' as const,
      serviceId: 900_000_002,
    };

    const result = await settleWithin(
      runWithRequestAdmission([titleKey], () =>
        runWithServarrServiceAdmission([service], async () => 'done')
      ),
      2_000
    );

    assert.equal(result, 'done');
    assert.equal(database.connections(), 1);
    assert.deepEqual(database.advisoryKeys, [
      titleKey,
      getServarrServiceAdmissionResource('suwayomi', service.serviceId),
    ]);
  });
});
