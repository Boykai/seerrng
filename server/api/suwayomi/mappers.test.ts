import {
  MINIMUM_REVISION,
  PINNED_REVISION,
  evaluateCapabilities,
  parseRevision,
} from '@server/api/suwayomi/capabilities';
import {
  SuwayomiError,
  classifyGraphQLErrors,
  interpretGraphQLResponse,
  reportSuwayomiError,
  toSuwayomiError,
} from '@server/api/suwayomi/errors';
import {
  mapChapter,
  mapHealth,
  mapMangaDetails,
  mapMangaSummary,
  mapQueue,
  mapSource,
  sanitizeVersion,
  text,
  toIdString,
} from '@server/api/suwayomi/mappers';
import { ROOT_FIELDS } from '@server/api/suwayomi/operations';
import logger from '@server/logger';
import { nullValueError, syntheticFailure } from '@server/test/fakeSuwayomi';
import { AxiosError, CanceledError } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const OP = 'Test';
const badResponse = { name: 'SuwayomiError', code: 'BAD_RESPONSE' };

const summary = {
  id: 7,
  sourceId: '9223372036854775807',
  url: '/title/fake-7',
  title: ' Fake\r\nTitle ',
  author: 'Fake Author',
  status: 'ONGOING',
  inLibrary: true,
  initialized: true,
};

const fields = (names: readonly string[]) => ({
  fields: names.map((name) => ({ name })),
});

const introspection = (
  query: readonly string[] = ROOT_FIELDS.query,
  mutation: readonly string[] = ROOT_FIELDS.mutation,
  mangaFields: string[] = ['id']
) => ({
  queryType: fields(query),
  mutationType: fields(mutation),
  mangaType: fields(mangaFields),
  chapterType: fields(['id']),
});

describe('Suwayomi response mapping', () => {
  it('keeps IDs as strings and rejects anything that is not a whole number', () => {
    assert.equal(toIdString(42), '42');
    assert.equal(toIdString('9223372036854775807'), '9223372036854775807');
    for (const value of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '1e3',
      '',
      null,
    ]) {
      assert.equal(toIdString(value), undefined, String(value));
    }
    assert.equal(toIdString('1'.repeat(20)), undefined);
  });

  it('strips control characters from display text', () => {
    assert.equal(text('a\r\nb\u0000c\u009f'), 'a  b c');
    assert.equal(text('   '), undefined);
    assert.equal(text('x'.repeat(600))?.length, 512);
    assert.equal(text(5), undefined);
  });

  it('maps a manga summary', () => {
    assert.deepEqual(mapMangaSummary(summary, OP), {
      id: '7',
      sourceId: '9223372036854775807',
      url: '/title/fake-7',
      title: 'Fake  Title',
      author: 'Fake Author',
      status: 'ONGOING',
      inLibrary: true,
      initialized: true,
    });
    assert.equal(
      mapMangaSummary({ ...summary, status: 'NEW' }, OP).status,
      'UNKNOWN'
    );
  });

  it('rejects summaries without a usable identity', () => {
    for (const patch of [
      { id: undefined },
      { id: -3 },
      { sourceId: 'abc' },
      { url: '' },
      { url: '/a\r\nb' },
      { url: 'x'.repeat(2_049) },
    ]) {
      assert.throws(
        () => mapMangaSummary({ ...summary, ...patch }, OP),
        badResponse
      );
    }
    assert.throws(() => mapMangaSummary(null, OP), badResponse);
  });

  it('maps details and keeps only seerrng meta', () => {
    const details = mapMangaDetails(
      {
        ...summary,
        description: ' line one\r\nline two\u0007 ',
        genre: ['Action', 7, ' Drama\n', ...Array(60).fill('Extra')],
        inLibraryAt: 0,
        lastFetchedAt: '1700000000',
        chaptersLastFetchedAt: 1_700_000_001,
        downloadCount: 3,
        unreadCount: 'many',
        hasDuplicateChapters: true,
        chapters: { totalCount: 12 },
        meta: [
          { key: 'seerrng.request', value: '{"requestId":"1"}' },
          { key: 'other.app', value: 'ignored' },
          { key: 'seerrng.big', value: 'x'.repeat(4_097) },
          { key: 'seerrng.number', value: 5 },
        ],
      },
      OP
    );
    assert.equal(details.description, 'line one\nline two');
    assert.equal(details.genre.length, 50);
    assert.deepEqual(details.genre.slice(0, 2), ['Action', 'Drama']);
    assert.equal(details.inLibraryAt, undefined);
    assert.equal(details.lastFetchedAt, '1700000000');
    assert.equal(details.chaptersLastFetchedAt, '1700000001');
    assert.equal(details.downloadCount, 3);
    assert.equal(details.unreadCount, 0);
    assert.equal(details.chapterCount, 12);
    assert.deepEqual(details.meta, { 'seerrng.request': '{"requestId":"1"}' });
  });

  it('maps chapters with safe defaults', () => {
    const chapter = mapChapter(
      {
        id: 11,
        mangaId: 7,
        url: '/chapter/11',
        name: 'Chapter 1',
        sourceOrder: 1,
        pageCount: -1,
        isDownloaded: 'yes',
      },
      OP
    );
    assert.equal(chapter.id, '11');
    assert.equal(chapter.chapterNumber, -1);
    assert.equal(chapter.pageCount, undefined);
    assert.equal(chapter.isDownloaded, false);
    assert.throws(() => mapChapter({ id: 11, url: '/c' }, OP), badResponse);
  });

  it('maps the download queue', () => {
    assert.deepEqual(
      mapQueue(
        {
          state: 'STARTED',
          queue: [
            {
              state: 'DOWNLOADING',
              progress: 0.5,
              tries: 1,
              chapter: { id: 3, mangaId: 7 },
            },
            { state: 'PAUSED', chapter: { id: 4, mangaId: 7 } },
          ],
        },
        OP
      ),
      {
        state: 'STARTED',
        items: [
          {
            chapterId: '3',
            mangaId: '7',
            state: 'DOWNLOADING',
            progress: 0.5,
            tries: 1,
          },
          {
            chapterId: '4',
            mangaId: '7',
            state: 'UNKNOWN',
            progress: undefined,
            tries: undefined,
          },
        ],
      }
    );
    assert.throws(
      () => mapQueue({ state: 'STARTED', queue: [{}] }, OP),
      badResponse
    );
    assert.throws(() => mapQueue({ state: 'STARTED' }, OP), badResponse);
  });

  it('maps sources without trusting their flags', () => {
    assert.deepEqual(
      mapSource(
        {
          id: '123',
          name: 'Fake Source',
          displayName: 'Fake Source (EN)',
          lang: 'en',
          contentWarning: 'SOMETHING',
          supportsLatest: 'true',
          extension: { hasUpdate: true, isObsolete: false },
        },
        OP
      ),
      {
        id: '123',
        name: 'Fake Source',
        displayName: 'Fake Source (EN)',
        lang: 'en',
        contentWarning: 'UNKNOWN',
        supportsLatest: false,
        hasUpdate: true,
        isObsolete: false,
      }
    );
  });

  it('derives health warnings', () => {
    const health = mapHealth(
      {
        aboutServer: { version: 'v2.4.2366' },
        settings: {
          downloadAsCbz: false,
          globalUpdateInterval: 12,
          maxSourcesInParallel: 'x',
        },
        downloadStatus: {
          state: 'STOPPED',
          queue: [{ state: 'ERROR' }, { state: 'QUEUED' }],
        },
        sources: { totalCount: 1 },
      },
      OP
    );
    assert.equal(health.version, 'v2.4.2366');
    assert.equal(health.downloaderState, 'STOPPED');
    assert.equal(health.queueLength, 2);
    assert.equal(health.queueErrors, 1);
    assert.equal(health.sourceCount, 0);
    assert.equal(health.settings.globalUpdateInterval, 12);
    assert.equal(health.settings.maxSourcesInParallel, undefined);
    assert.deepEqual(health.warnings, [
      'CBZ_DISABLED',
      'NO_SOURCES',
      'QUEUE_ERRORS',
    ]);
    assert.throws(() => mapHealth({}, OP), badResponse);
  });

  it('accepts only plain version strings', () => {
    assert.equal(sanitizeVersion('v2.4.2366'), 'v2.4.2366');
    assert.equal(sanitizeVersion('v2\r\nfake'), undefined);
    assert.equal(sanitizeVersion('x'.repeat(65)), undefined);
  });
});

describe('Suwayomi capabilities', () => {
  it('parses revisions', () => {
    assert.equal(parseRevision('v2.4.2366'), 2366);
    assert.equal(parseRevision('2.1.2238-preview'), 2238);
    assert.equal(parseRevision('preview'), undefined);
    assert.equal(parseRevision(undefined), undefined);
  });

  it('supports the pinned release with every required field', () => {
    assert.deepEqual(
      evaluateCapabilities({
        about: { version: `v2.4.${PINNED_REVISION}`, buildType: 'Stable' },
        introspection: introspection(),
      }),
      {
        version: `v2.4.${PINNED_REVISION}`,
        revision: PINNED_REVISION,
        buildType: 'Stable',
        supported: true,
        missingFields: [],
        partialFetchResults: true,
        perUserDownloadState: false,
        warnings: [],
      }
    );
  });

  it('rejects a schema that lacks a required field whatever its version', () => {
    const capabilities = evaluateCapabilities({
      about: { version: 'v9.9.9999' },
      introspection: introspection(
        ROOT_FIELDS.query.filter((field) => field !== 'metas')
      ),
    });
    assert.equal(capabilities.supported, false);
    assert.deepEqual(capabilities.missingFields, ['Query.metas']);
  });

  it('lets a complete schema decide support whatever the version says', () => {
    const old = evaluateCapabilities({
      about: { version: `v2.0.${MINIMUM_REVISION - 1}` },
      introspection: introspection(),
    });
    assert.equal(old.supported, true);
    assert.equal(old.partialFetchResults, false);
    assert.deepEqual(old.warnings, ['BELOW_PINNED_REVISION']);
    const unknown = evaluateCapabilities({
      about: { version: 'nightly' },
      introspection: introspection(),
    });
    assert.equal(unknown.supported, true);
    assert.deepEqual(unknown.warnings, ['UNKNOWN_VERSION']);
  });

  it('reports per-user download state from the schema', () => {
    const capabilities = evaluateCapabilities({
      about: { version: 'v2.5.2500' },
      introspection: introspection(undefined, undefined, ['id', 'user']),
    });
    assert.equal(capabilities.perUserDownloadState, true);
    assert.deepEqual(capabilities.warnings, ['PER_USER_SCHEMA']);
  });

  it('falls back to the version when introspection is unavailable', () => {
    const old = evaluateCapabilities({ about: { version: 'v2.1.2230' } });
    assert.equal(old.supported, true);
    assert.equal(old.partialFetchResults, false);
    assert.deepEqual(old.warnings, [
      'INTROSPECTION_UNAVAILABLE',
      'BELOW_PINNED_REVISION',
    ]);
    assert.equal(
      evaluateCapabilities({
        about: { version: `v2.0.${MINIMUM_REVISION - 1}` },
      }).supported,
      false
    );
    const unknown = evaluateCapabilities({ about: { version: 'nightly' } });
    assert.equal(unknown.supported, false);
    assert.deepEqual(unknown.warnings, [
      'INTROSPECTION_UNAVAILABLE',
      'UNKNOWN_VERSION',
    ]);
  });
});

describe('Suwayomi error classification', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('classifies GraphQL errors by priority and drops their text', () => {
    assert.equal(
      classifyGraphQLErrors([
        { message: 'Manga not found' },
        { message: 'Incorrect username or password.' },
      ]),
      'AUTH_FAILED'
    );
    assert.equal(
      classifyGraphQLErrors([{ message: 'Unauthorized' }]),
      'AUTH_REQUIRED'
    );
    assert.equal(
      classifyGraphQLErrors([
        { message: 'Cannot login while already logged-in' },
      ]),
      'AUTH_MODE_MISMATCH'
    );
    assert.equal(
      classifyGraphQLErrors([
        { message: syntheticFailure('NoSuchElementException') },
      ]),
      'NOT_FOUND'
    );
    assert.equal(
      classifyGraphQLErrors([{ message: syntheticFailure() }]),
      'UPSTREAM_ERROR'
    );
    assert.equal(classifyGraphQLErrors(['Unauthorized', 5]), 'UPSTREAM_ERROR');
  });

  it('reads a lookup that found nothing as NOT_FOUND', () => {
    assert.equal(
      classifyGraphQLErrors([nullValueError(['meta'])]),
      'NOT_FOUND'
    );
    assert.throws(
      () =>
        interpretGraphQLResponse(
          OP,
          {
            status: 200,
            headers: {},
            data: { data: null, errors: [nullValueError(['manga'])] },
          },
          'UI_LOGIN'
        ),
      { code: 'NOT_FOUND', errorCount: 1 }
    );
    // Below a lookup, on any other root, or without a path: a server fault.
    for (const error of [
      nullValueError(['manga', 'chapters', 'totalCount']),
      nullValueError(['enqueueChapterDownloads']),
      { message: nullValueError(['meta']).message },
    ]) {
      assert.equal(classifyGraphQLErrors([error]), 'UPSTREAM_ERROR');
    }
    assert.equal(
      classifyGraphQLErrors([
        nullValueError(['meta']),
        { message: 'Unauthorized' },
      ]),
      'AUTH_REQUIRED'
    );
  });

  it('reads auth failures from errors on HTTP 200', () => {
    assert.throws(
      () =>
        interpretGraphQLResponse(
          OP,
          {
            status: 200,
            headers: {},
            data: { data: null, errors: [{ message: 'Unauthorized' }] },
          },
          'UI_LOGIN'
        ),
      { code: 'AUTH_REQUIRED', httpStatus: 200, errorCount: 1 }
    );
  });

  it('accepts a partial result only when asked, and once a root field resolved', () => {
    const response = {
      status: 200,
      headers: {},
      data: { data: { value: 1 }, errors: [{ message: syntheticFailure() }] },
    };
    const withErrors = (data: unknown, message: string) => ({
      ...response,
      data: { data, errors: [{ message }] },
    });
    assert.deepEqual(interpretGraphQLResponse(OP, response, 'NONE', true), {
      data: { value: 1 },
      errorCode: 'UPSTREAM_ERROR',
      errorCount: 1,
    });
    assert.throws(() => interpretGraphQLResponse(OP, response, 'NONE'), {
      code: 'UPSTREAM_ERROR',
    });
    // Source text that reads like an auth failure, beside resolved data.
    assert.deepEqual(
      interpretGraphQLResponse(
        OP,
        withErrors({ value: 1, other: null }, 'HTTP 401 Unauthorized'),
        'UI_LOGIN',
        true
      ),
      {
        data: { value: 1, other: null },
        errorCode: 'UPSTREAM_ERROR',
        errorCount: 1,
      }
    );
    assert.throws(
      () =>
        interpretGraphQLResponse(
          OP,
          withErrors({ value: null }, 'Unauthorized'),
          'UI_LOGIN',
          true
        ),
      { code: 'AUTH_REQUIRED' }
    );
    assert.throws(
      () =>
        interpretGraphQLResponse(
          OP,
          withErrors(
            { value: null, other: null },
            syntheticFailure('NoSuchElementException')
          ),
          'UI_LOGIN',
          true
        ),
      { code: 'NOT_FOUND' }
    );
  });

  it('maps HTTP statuses by auth mode', () => {
    const basic = { 'www-authenticate': 'Basic realm="Fake"' };
    const cases: [
      number,
      unknown,
      'NONE' | 'BASIC_AUTH' | 'UI_LOGIN',
      unknown,
      string,
    ][] = [
      [401, basic, 'NONE', null, 'AUTH_MODE_MISMATCH'],
      [401, basic, 'BASIC_AUTH', null, 'AUTH_FAILED'],
      [401, {}, 'UI_LOGIN', null, 'AUTH_REQUIRED'],
      [403, {}, 'UI_LOGIN', null, 'AUTH_FAILED'],
      [
        400,
        {},
        'UI_LOGIN',
        'Cannot use refresh token to access',
        'AUTH_REQUIRED',
      ],
      [
        400,
        {},
        'UI_LOGIN',
        { message: 'Token intended for different audience' },
        'AUTH_REQUIRED',
      ],
      [502, {}, 'UI_LOGIN', '<html>bad gateway</html>', 'HTTP_ERROR'],
      [500, {}, 'UI_LOGIN', { data: { value: 1 } }, 'HTTP_ERROR'],
      [200, {}, 'UI_LOGIN', '<html></html>', 'BAD_RESPONSE'],
      [200, {}, 'UI_LOGIN', { data: null }, 'BAD_RESPONSE'],
    ];
    for (const [status, headers, mode, data, code] of cases) {
      assert.throws(
        () => interpretGraphQLResponse(OP, { status, headers, data }, mode),
        { code },
        `${status} ${mode}`
      );
    }
  });

  it('converts transport failures to stable codes without keeping the cause', () => {
    const withCode = (code: string) =>
      Object.assign(new Error(syntheticFailure()), { code });
    const cases: [unknown, string][] = [
      [new CanceledError(), 'ABORTED'],
      [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'ABORTED'],
      [withCode('ECONNABORTED'), 'TIMEOUT'],
      [withCode('ECONNREFUSED'), 'UNREACHABLE'],
      [withCode('EACCES'), 'REQUEST_REFUSED'],
      [withCode('ERR_FR_REDIRECTION_FAILURE'), 'REQUEST_REFUSED'],
      [new Error('wrapper', { cause: withCode('ETIMEDOUT') }), 'TIMEOUT'],
      [
        new Error('External API request target is not allowed.'),
        'REQUEST_REFUSED',
      ],
      [
        new AxiosError('maxContentLength size of 10 exceeded'),
        'RESPONSE_TOO_LARGE',
      ],
      [new AxiosError('socket hang up'), 'UNREACHABLE'],
      [
        new AxiosError('stream has been aborted', AxiosError.ERR_BAD_RESPONSE),
        'UNREACHABLE',
      ],
      ['text', 'BAD_RESPONSE'],
    ];
    for (const [input, code] of cases) {
      const error = toSuwayomiError(input, OP);
      assert.equal(error.code, code, String(input));
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /FakeFailure|\r|\n/);
    }
  });

  it('marks only transient failures retryable', () => {
    assert.equal(new SuwayomiError('TIMEOUT', OP).retryable, true);
    assert.equal(new SuwayomiError('AUTH_FAILED', OP).retryable, false);
    assert.equal(
      new SuwayomiError('HTTP_ERROR', OP, { httpStatus: 503 }).retryable,
      true
    );
    assert.equal(
      new SuwayomiError('HTTP_ERROR', OP, { httpStatus: 400 }).retryable,
      false
    );
  });

  it('logs one sanitized summary per error', () => {
    const warn = mock.method(logger, 'warn', () => logger);
    const debug = mock.method(logger, 'debug', () => logger);
    const failure = new SuwayomiError('AUTH_FAILED', 'Login', {
      httpStatus: 200,
      errorCount: 1,
    });
    reportSuwayomiError(failure);
    reportSuwayomiError(failure);
    reportSuwayomiError(new SuwayomiError('NOT_FOUND', 'MangaDetails'));
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, [
      'Suwayomi request failed',
      {
        label: 'Suwayomi',
        operation: 'Login',
        code: 'AUTH_FAILED',
        errorCount: 1,
        httpStatus: 200,
      },
    ]);
    assert.equal(debug.mock.callCount(), 1);
  });
});
