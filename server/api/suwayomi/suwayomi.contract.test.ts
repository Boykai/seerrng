// Contract tests against disposable Suwayomi-Server containers at the pinned
// release. scripts/suwayomi-contract-checks.mjs starts one server per auth
// mode and sets the SEERR_TEST_SUWAYOMI_* variables; without them every test
// here is skipped. The servers have no route to the internet and no
// extensions: the only source is Suwayomi's built-in local source, with a
// fixture manga that the harness generates at run time.

import SuwayomiAPI from '@server/api/suwayomi';
import { PINNED_REVISION } from '@server/api/suwayomi/capabilities';
import {
  SuwayomiError,
  interpretGraphQLResponse,
  type SuwayomiErrorCode,
} from '@server/api/suwayomi/errors';
import {
  REQUEST_STAMP_KEY,
  SUWAYOMI_OPERATIONS,
} from '@server/api/suwayomi/operations';
import type {
  SuwayomiAPIOptions,
  SuwayomiAuthConfig,
  SuwayomiByteStream,
  SuwayomiChapter,
} from '@server/api/suwayomi/types';
import logger from '@server/logger';
import {
  NoDeprecatedCustomRule,
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
  type IntrospectionQuery,
} from 'graphql';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { afterEach, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';

const env = process.env;
// Suwayomi's built-in local source.
const LOCAL_SOURCE_ID = '0';
const MISSING_ID = '999999';
const CATEGORY = 'SeerrNG contract';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
// One test moves the client's clock; waits keep using the real one.
const realNow = Date.now.bind(Date);

const seconds = (name: string, fallback: number) => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const TOKEN_SECONDS = seconds('SEERR_TEST_SUWAYOMI_TOKEN_EXPIRY_SECONDS', 15);
const REFRESH_SECONDS = seconds(
  'SEERR_TEST_SUWAYOMI_REFRESH_EXPIRY_SECONDS',
  45
);

interface Instance {
  url: string;
  username: string;
  password: string;
}

const instance = (key: string): Instance => ({
  url: env[`SEERR_TEST_SUWAYOMI_${key}_URL`] ?? '',
  username: env[`SEERR_TEST_SUWAYOMI_${key}_USERNAME`] ?? '',
  password: env[`SEERR_TEST_SUWAYOMI_${key}_PASSWORD`] ?? '',
});

// UI_LOGIN with the fixture, 15 s access tokens and 45 s refresh tokens.
const MAIN = instance('MAIN');
const BASIC = instance('BASIC');
const SIMPLE = instance('SIMPLE');
const NONE = instance('NONE');

interface Fixture {
  title: string;
  downloadedChapter: string;
  pendingChapter: string;
  archiveBytes: number;
  archiveSha256: string;
  coverSha256: string;
}

const readFixture = () =>
  JSON.parse(env.SEERR_TEST_SUWAYOMI_FIXTURE ?? 'null') as Fixture;

const uiLogin = (
  target: Instance,
  password = target.password
): SuwayomiAuthConfig => ({
  mode: 'UI_LOGIN',
  username: target.username,
  password,
});

const basicAuth = (
  target: Instance,
  password = target.password
): SuwayomiAuthConfig => ({
  mode: 'BASIC_AUTH',
  username: target.username,
  password,
});

const NO_AUTH: SuwayomiAuthConfig = { mode: 'NONE' };

const connect = (
  target: Instance,
  auth: SuwayomiAuthConfig,
  overrides: Partial<SuwayomiAPIOptions> = {}
) =>
  new SuwayomiAPI({
    url: target.url,
    auth,
    readback: { attempts: 2, delayMs: 500 },
    // The unit tests cover the mode warnings; these short-lived clients
    // would only repeat them.
    warnInsecureAuthMode: false,
    ...overrides,
  });

const main = () => connect(MAIN, uiLogin(MAIN));

const failsWith = (code: SuwayomiErrorCode) => (error: unknown) => {
  assert.ok(
    error instanceof SuwayomiError,
    `expected a SuwayomiError, not ${error instanceof Error ? error.name : typeof error}`
  );
  assert.equal(error.code, code);
  return true;
};

const rejection = (result: PromiseSettledResult<unknown>) =>
  result.status === 'rejected' ? result.reason : new Error('It succeeded.');

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const readAll = async (opening: Promise<SuwayomiByteStream>) =>
  buffer((await opening).stream);

/** Records every log call, rendered the way a log transport would see it. */
const captureLogs = () => {
  const calls: unknown[][] = [];
  for (const level of ['error', 'warn', 'info', 'debug', 'verbose'] as const) {
    mock.method(logger, level, (...args: unknown[]) => {
      calls.push([level, ...args]);
      return logger;
    });
  }
  return () => inspect(calls, { depth: 10, breakLength: Infinity });
};

/** Fails without printing the log text, which could hold what it found. */
const assertCleanLogs = (text: string, secrets: string[]) => {
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(text.includes(secret), false, 'A secret reached the logs.');
  }
  assert.equal(JWT_PATTERN.test(text), false, 'A token reached the logs.');
  assert.equal(
    /exception|incorrect|unauthorized/i.test(text),
    false,
    'Raw Suwayomi text reached the logs.'
  );
};

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

/** A GraphQL request outside the client, to look at the server's raw answer. */
const post = async (
  target: Instance,
  query: string,
  variables: Record<string, unknown> = {},
  authorization?: string
): Promise<RawResponse> => {
  const response = await fetch(new URL('api/graphql', target.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ query, variables }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Suwayomi answers some rejections with plain text.
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data,
  };
};

const sleepUntil = async (deadline: number) => {
  const remaining = deadline - realNow();
  if (remaining > 0) {
    await sleep(remaining);
  }
};

interface Internals {
  login(): Promise<unknown>;
  refresh(refreshToken: string): Promise<unknown>;
  postGraphQL(name: string, ...rest: unknown[]): Promise<unknown>;
}

/** Counts logins, refreshes and Health requests (including retries). */
const countCalls = (client: SuwayomiAPI) => {
  const internals = client as unknown as Internals;
  const login = mock.method(internals, 'login');
  const refresh = mock.method(internals, 'refresh');
  const posts = mock.method(internals, 'postGraphQL');
  return () => ({
    login: login.mock.callCount(),
    refresh: refresh.mock.callCount(),
    health: posts.mock.calls.filter((call) => call.arguments[0] === 'Health')
      .length,
  });
};

interface FixtureManga {
  id: string;
  url: string;
  chapters: SuwayomiChapter[];
  downloaded: SuwayomiChapter;
  pending: SuwayomiChapter;
}

let fixtureManga: Promise<FixtureManga> | undefined;

/** Finds the fixture through the local source and fetches its chapters once. */
const loadFixtureManga = () =>
  (fixtureManga ??= (async () => {
    const fixture = readFixture();
    const client = main();
    const page = await client.searchSource(LOCAL_SOURCE_ID, fixture.title);
    const manga = page.mangas.find(({ title }) => title === fixture.title);
    assert.ok(manga, 'The local source does not list the fixture.');
    const result = await client.fetchMangaAndChapters(manga.id);
    assert.equal(result.fresh, true);
    const chapters = result.chapters ?? [];
    const chapter = (name: string) => {
      const found = chapters.find((candidate) => candidate.name === name);
      assert.ok(found, `The fixture has no chapter named ${name}.`);
      return found;
    };
    return {
      id: manga.id,
      url: manga.url,
      chapters,
      downloaded: chapter(fixture.downloadedChapter),
      pending: chapter(fixture.pendingChapter),
    };
  })());

describe('Suwayomi contract', { skip: !MAIN.url }, () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('schema', () => {
    it('accepts every operation without deprecated fields', async () => {
      const response = await post(
        NONE,
        getIntrospectionQuery({ inputValueDeprecation: true })
      );
      const body = response.data as {
        data?: IntrospectionQuery;
        errors?: unknown[];
      };
      assert.equal(response.status, 200);
      assert.equal(body.errors, undefined);
      assert.ok(body.data, 'Introspection returned no schema.');
      const schema = buildClientSchema(body.data);
      const failures: string[] = [];
      for (const [name, { document }] of Object.entries(SUWAYOMI_OPERATIONS)) {
        const ast = parse(document);
        for (const error of [
          ...validate(schema, ast),
          ...validate(schema, ast, [NoDeprecatedCustomRule]),
        ]) {
          failures.push(`${name}: ${error.message}`);
        }
      }
      assert.deepEqual(failures, []);
    });
  });

  describe('server', () => {
    it('reports the pinned release and its capabilities', async () => {
      const { version, buildType, ...capabilities } =
        await main().getCapabilities();
      assert.equal(typeof version, 'string');
      assert.equal(typeof buildType, 'string');
      assert.deepEqual(capabilities, {
        revision: PINNED_REVISION,
        supported: true,
        missingFields: [],
        partialFetchResults: true,
        perUserDownloadState: false,
        warnings: [],
      });
    });

    it('reports health without installed sources', async () => {
      const health = await main().getHealth();
      assert.equal(health.settings.downloadAsCbz, true);
      assert.equal(health.sourceCount, 0);
      assert.equal(health.queueLength, 0);
      assert.equal(health.queueErrors, 0);
      assert.deepEqual(health.warnings, ['NO_SOURCES']);
    });
  });

  describe('authentication modes', () => {
    it('logs in with UI_LOGIN and rejects wrong, missing and misused credentials', async () => {
      const logs = captureLogs();
      assert.deepEqual(await main().detectAuthMode(), {
        mode: 'UI_LOGIN',
        supported: true,
        authenticated: true,
        matchesConfigured: true,
        warnings: [],
      });

      const wrong = randomUUID();
      const wrongClient = connect(MAIN, uiLogin(MAIN, wrong));
      await assert.rejects(wrongClient.getHealth(), failsWith('AUTH_FAILED'));
      await assert.rejects(
        wrongClient.detectAuthMode(),
        failsWith('AUTH_FAILED')
      );
      await assert.rejects(
        connect(MAIN, NO_AUTH).getHealth(),
        failsWith('AUTH_REQUIRED')
      );

      // Suwayomi refuses a refresh token used as an access token with a
      // plain-text HTTP 400.
      const login = await post(MAIN, SUWAYOMI_OPERATIONS.Login.document, {
        username: MAIN.username,
        password: MAIN.password,
      });
      const refreshToken = (
        login.data as { data?: { login?: { refreshToken?: unknown } } }
      ).data?.login?.refreshToken;
      assert.equal(typeof refreshToken, 'string');
      const misuse = await post(
        MAIN,
        SUWAYOMI_OPERATIONS.AuthTest.document,
        {},
        `Bearer ${String(refreshToken)}`
      );
      assert.throws(
        () => interpretGraphQLResponse('AuthTest', misuse, 'UI_LOGIN'),
        failsWith('AUTH_REQUIRED')
      );

      assertCleanLogs(logs(), [MAIN.password, wrong]);
    });

    it('detects BASIC_AUTH and flags it', async () => {
      const client = connect(BASIC, basicAuth(BASIC));
      assert.deepEqual(await client.detectAuthMode(), {
        mode: 'BASIC_AUTH',
        supported: true,
        authenticated: true,
        matchesConfigured: true,
        warnings: ['BASIC_AUTH_IN_USE'],
      });
      assert.equal((await client.getHealth()).sourceCount, 0);

      const wrong = connect(BASIC, basicAuth(BASIC, randomUUID()));
      await assert.rejects(wrong.getHealth(), failsWith('AUTH_FAILED'));
      await assert.rejects(wrong.detectAuthMode(), failsWith('AUTH_FAILED'));

      const uiClient = connect(BASIC, uiLogin(BASIC));
      assert.deepEqual(await uiClient.detectAuthMode(), {
        mode: 'BASIC_AUTH',
        supported: true,
        authenticated: false,
        matchesConfigured: false,
        warnings: ['MODE_MISMATCH', 'BASIC_AUTH_IN_USE'],
      });
      await assert.rejects(
        uiClient.getHealth(),
        failsWith('AUTH_MODE_MISMATCH')
      );
    });

    it('detects SIMPLE_LOGIN, which ignores API tokens, as unsupported', async () => {
      const client = connect(SIMPLE, uiLogin(SIMPLE));
      assert.deepEqual(await client.detectAuthMode(), {
        mode: 'SIMPLE_LOGIN',
        supported: false,
        authenticated: false,
        matchesConfigured: false,
        warnings: ['MODE_MISMATCH'],
      });
      await assert.rejects(client.getHealth(), failsWith('AUTH_REQUIRED'));
    });

    it('detects NONE and flags that authentication is off', async () => {
      const client = connect(NONE, NO_AUTH);
      assert.deepEqual(await client.detectAuthMode(), {
        mode: 'NONE',
        supported: true,
        authenticated: true,
        matchesConfigured: true,
        warnings: ['AUTH_DISABLED'],
      });
      assert.equal((await client.getHealth()).sourceCount, 0);

      const uiClient = connect(NONE, {
        mode: 'UI_LOGIN',
        username: 'seerrng',
        password: randomUUID(),
      });
      assert.deepEqual(await uiClient.detectAuthMode(), {
        mode: 'NONE',
        supported: true,
        authenticated: false,
        matchesConfigured: false,
        warnings: ['MODE_MISMATCH', 'AUTH_DISABLED'],
      });
    });
  });

  describe('errors', () => {
    it('maps unknown IDs and sources to stable codes', async () => {
      const logs = captureLogs();
      const client = main();
      await assert.rejects(
        client.getMangaDetails(MISSING_ID),
        failsWith('NOT_FOUND')
      );
      await assert.rejects(
        client.fetchMangaAndChapters(MISSING_ID),
        failsWith('NOT_FOUND')
      );
      assert.deepEqual(await client.getChapterStates([MISSING_ID]), []);
      assert.deepEqual((await client.getAvailability([MISSING_ID])).mangas, []);
      await assert.rejects(
        client.searchSource(MISSING_ID, 'contract'),
        failsWith('UPSTREAM_ERROR')
      );
      await assert.rejects(
        client.streamMangaThumbnail(MISSING_ID),
        failsWith('NOT_FOUND')
      );
      assertCleanLogs(logs(), [MAIN.password]);
    });
  });

  describe('library', () => {
    it('finds the fixture through the local source and reads its chapters', async () => {
      const fixture = readFixture();
      const manga = await loadFixtureManga();
      const client = main();
      assert.deepEqual(manga.chapters.map(({ name }) => name).sort(), [
        fixture.downloadedChapter,
        fixture.pendingChapter,
      ]);
      assert.ok(manga.chapters.every(({ mangaId }) => mangaId === manga.id));
      assert.equal(
        (await client.findMangaByNaturalKey(LOCAL_SOURCE_ID, manga.url))?.id,
        manga.id
      );
      // A placed archive does not change the stored download state.
      const states = await client.getChapterStates([
        manga.downloaded.id,
        manga.pending.id,
      ]);
      assert.deepEqual(
        states.map(({ isDownloaded }) => isDownloaded),
        [false, false]
      );
      assert.deepEqual(
        (await client.getChaptersToDownload(manga.id))
          .map(({ id }) => id)
          .sort(),
        [manga.downloaded.id, manga.pending.id].sort()
      );
      assert.deepEqual(await client.getDownloadedChapters(manga.id), []);
    });

    it('creates the category once and files the manga in the library', async () => {
      const client = main();
      const { id } = await loadFixtureManga();
      const category = await client.findOrCreateCategory(CATEGORY);
      assert.equal(category.name, CATEGORY);
      assert.equal(
        (await client.findOrCreateCategory(CATEGORY)).id,
        category.id
      );

      await client.setInLibrary(id, true);
      await client.addMangaToCategory(id, category.id);
      await client.addMangaToCategory(id, category.id);
      await client.removeMangaFromCategory(id, category.id);
      await client.removeMangaFromCategory(id, category.id);

      const { mangas } = await client.getAvailability([id]);
      assert.equal(mangas.length, 1);
      assert.equal(mangas[0].inLibrary, true);
      assert.equal(mangas[0].chapterCount, 2);
      assert.equal((await client.getMangaDetails(id)).inLibrary, true);
    });

    it('keeps the instance marker, request stamp and request index in meta', async () => {
      const client = main();
      const { id } = await loadFixtureManga();
      // No test writes meta on this server, so the key is missing on reruns.
      assert.equal(await connect(NONE, NO_AUTH).getInstanceMarker(), undefined);
      const marker = randomUUID();
      await client.setInstanceMarker(marker);
      assert.equal(await client.getInstanceMarker(), marker);

      const stamp = JSON.stringify({ requestId: '42', instance: marker });
      await client.setRequestStamp(id, stamp);
      assert.equal(
        (await client.getMangaDetails(id)).meta[REQUEST_STAMP_KEY],
        stamp
      );
      await client.deleteRequestStamp(id);
      await client.deleteRequestStamp(id);
      assert.deepEqual((await client.getMangaDetails(id)).meta, {});

      await client.setRequestIndex('42', id);
      assert.deepEqual(await client.listRequestIndex(), [
        { requestId: '42', value: id },
      ]);
      await client.deleteRequestIndex('42');
      await client.deleteRequestIndex('42');
      assert.deepEqual(await client.listRequestIndex(), []);
    });
  });

  describe('chapter archives', () => {
    it('streams a downloaded chapter and refuses one that is not downloaded', async () => {
      const fixture = readFixture();
      const { downloaded, pending } = await loadFixtureManga();
      const client = main();
      assert.deepEqual(await client.headChapterArchive(downloaded.id), {
        contentLength: fixture.archiveBytes,
        contentType: 'application/vnd.comicbook+zip',
      });
      const archive = await client.streamChapterArchive(downloaded.id);
      assert.equal(archive.contentLength, fixture.archiveBytes);
      const bytes = await buffer(archive.stream);
      assert.equal(bytes.length, fixture.archiveBytes);
      assert.equal(sha256(bytes), fixture.archiveSha256);

      // Suwayomi answers HEAD with an empty 200 and GET with 400.
      await assert.rejects(
        client.headChapterArchive(pending.id),
        failsWith('NOT_DOWNLOADED')
      );
      await assert.rejects(
        client.streamChapterArchive(pending.id),
        failsWith('NOT_DOWNLOADED')
      );
    });

    it('refuses an archive above the size limit', async () => {
      const fixture = readFixture();
      const { downloaded } = await loadFixtureManga();
      const client = connect(MAIN, uiLogin(MAIN), {
        limits: { chapterArchiveBytes: fixture.archiveBytes - 1 },
      });
      await assert.rejects(
        client.headChapterArchive(downloaded.id),
        failsWith('RESPONSE_TOO_LARGE')
      );
      await assert.rejects(
        readAll(client.streamChapterArchive(downloaded.id)),
        failsWith('RESPONSE_TOO_LARGE')
      );
    });

    it('streams the cover thumbnail', async () => {
      const fixture = readFixture();
      const { id } = await loadFixtureManga();
      const thumbnail = await main().streamMangaThumbnail(id);
      const bytes = await buffer(thumbnail.stream);
      assert.equal(thumbnail.contentType, 'image/png');
      assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE));
      assert.equal(sha256(bytes), fixture.coverSha256);
    });
  });

  describe('queue mutations', () => {
    it(
      'reads back mutations that Suwayomi gives up on after 30 s',
      { timeout: 150_000 },
      async () => {
        const client = main();
        const [enqueue, dequeue, start] = await Promise.allSettled([
          client.enqueueChapters([MISSING_ID]),
          client.dequeueChapters([MISSING_ID]),
          client.startDownloader(),
        ]);
        // An unknown chapter was never queued, so only the dequeue is confirmed.
        failsWith('UPSTREAM_ERROR')(rejection(enqueue));
        assert.deepEqual(
          dequeue.status === 'fulfilled' ? dequeue.value : rejection(dequeue),
          { confirmedBy: 'readback' }
        );
        failsWith('UPSTREAM_ERROR')(rejection(start));
        assert.deepEqual((await client.getQueue()).items, []);
      }
    );

    it(
      'reads back a mutation that the client timed out',
      { timeout: 60_000 },
      async () => {
        const client = connect(MAIN, uiLogin(MAIN), {
          timeouts: { queue: 2_000 },
        });
        assert.deepEqual(await client.dequeueChapters([MISSING_ID]), {
          confirmedBy: 'readback',
        });
        await assert.rejects(
          client.enqueueChapters([MISSING_ID]),
          failsWith('TIMEOUT')
        );
      }
    );
  });

  describe('token renewal', () => {
    const timeout = (REFRESH_SECONDS + 30) * 1_000;

    it(
      'refreshes before the access token expires and logs in again after the refresh token expires',
      { timeout },
      async () => {
        const logs = captureLogs();
        const client = main();
        const counts = countCalls(client);
        const started = realNow();
        await client.getHealth();
        assert.deepEqual(counts(), { login: 1, refresh: 0, health: 1 });

        // Inside the renewal window, before the access token expires.
        await sleepUntil(started + TOKEN_SECONDS * 750);
        await client.getHealth();
        assert.deepEqual(counts(), { login: 1, refresh: 1, health: 2 });

        await sleepUntil(started + (REFRESH_SECONDS + 10) * 1_000);
        await client.getHealth();
        assert.deepEqual(counts(), { login: 2, refresh: 1, health: 3 });
        assertCleanLogs(logs(), [MAIN.password]);
      }
    );

    it(
      'recovers when the SeerrNG clock is a minute behind Suwayomi',
      { timeout },
      async () => {
        const logs = captureLogs();
        // The client reads the clock it was created with.
        mock.method(Date, 'now', () => realNow() - 60_000);
        const client = main();
        const counts = countCalls(client);
        const started = realNow();
        await client.getHealth();
        assert.deepEqual(counts(), { login: 1, refresh: 0, health: 1 });

        // The client still trusts the expired access token: Suwayomi rejects
        // it, and one refresh recovers.
        await sleepUntil(started + (TOKEN_SECONDS + 10) * 1_000);
        await client.getHealth();
        assert.deepEqual(counts(), { login: 1, refresh: 1, health: 3 });

        // Now the refresh token has expired too, so the client logs in again.
        await sleepUntil(started + (REFRESH_SECONDS + 10) * 1_000);
        await client.getHealth();
        assert.deepEqual(counts(), { login: 2, refresh: 2, health: 5 });
        assertCleanLogs(logs(), [MAIN.password]);
      }
    );
  });
});
