import { ROOT_FIELDS } from '@server/api/suwayomi/operations';
import { parse, visit, type DocumentNode } from 'graphql';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A scriptable stand-in for Suwayomi-Server used by the tier-1 tests. It
 * models each auth mode's observable behaviour (status codes, GraphQL
 * `errors`, token lifetimes) with synthetic data only.
 */
export type FakeAuthMode = 'NONE' | 'BASIC_AUTH' | 'SIMPLE_LOGIN' | 'UI_LOGIN';

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings and buffers as they are. */
  body?: unknown;
  /** Waits before sending the status line. */
  delayMs?: number;
  /** Never answers; the client has to time out or abort. */
  hang?: boolean;
  /** Streams the body in these chunks instead of `body`. */
  chunks?: (Buffer | string)[];
  chunkDelayMs?: number;
  /** Sends this many chunks, then stalls without ending the response. */
  stallAfterChunks?: number;
  /** Sends this many chunks, then drops the connection. */
  dropAfterChunks?: number;
}

export interface FakeRequest {
  method: string;
  /** Path and query string exactly as received. */
  url: string;
  headers: IncomingHttpHeaders;
  operationName?: string;
  query?: string;
  variables: Record<string, unknown>;
  /** Resolves when the response closes: true if it finished normally. */
  closed: Promise<boolean>;
}

export type FakeHandler = (
  request: FakeRequest
) => FakeReply | Promise<FakeReply>;

export interface FakeSuwayomiOptions {
  mode?: FakeAuthMode;
  username?: string;
  password?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /** Serve below a sub-path, as a reverse proxy would. */
  basePath?: string;
}

export interface FakeSuwayomi {
  /** Base URL to configure the client with. */
  url: string;
  origin: string;
  requests: FakeRequest[];
  readonly logins: number;
  readonly refreshes: number;
  /**
   * Scripts replies for an operation. Each call consumes the next reply and
   * the last one repeats. Auth checks run first, as on the real server.
   */
  onOperation(name: string, ...replies: (FakeReply | FakeHandler)[]): void;
  onRoute(
    method: string,
    path: string,
    ...replies: (FakeReply | FakeHandler)[]
  ): void;
  operations(name: string): FakeRequest[];
  /** Every access and refresh token issued so far. */
  issuedTokens(): string[];
  /** Makes every access token issued so far invalid on the server. */
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  close(): Promise<void>;
}

export const FAKE_VERSION = 'v2.4.2366';
const PUBLIC_OPERATIONS = new Set(['Probe']);
const TOKEN_OPERATIONS = new Set(['Login', 'Refresh']);

/** GraphQL data reply. */
export const graphqlData = (data: unknown, status = 200): FakeReply => ({
  status,
  body: { data },
});

/** GraphQL `errors` reply; Suwayomi answers these with HTTP 200. */
export const graphqlErrors = (
  messages: string[],
  data: unknown = null
): FakeReply => ({
  body: {
    data,
    errors: messages.map((message) => ({ message, locations: [], path: [] })),
  },
});

/** A synthetic upstream failure with a stack fragment and CRLF breaks. */
export const syntheticFailure = (detail = 'synthetic failure') =>
  `com.example.FakeFailureException: ${detail}\r\n\tat com.example.Fake.run(Fake.kt:1)\r\n`;

/** graphql-java's error when a non-null field resolved to null. */
export const nullValueError = (path: string[]) => ({
  message: `The field at path '/${path.join('/')}' was declared as a non null type, but the code involved in retrieving data has wrongly returned a null value.`,
  locations: [],
  path,
});

/** How a root lookup such as `manga(id:)` or `meta(key:)` reports a miss. */
export const missingLookup = (field: string): FakeReply => ({
  body: { data: null, errors: [nullValueError([field])] },
});

export interface FakeSchema {
  version?: string;
  buildType?: string;
  queryTypeName?: string;
  mutationTypeName?: string;
  queryFields?: readonly string[];
  mutationFields?: readonly string[];
  /** `null` leaves the type out, as a server without it would. */
  mangaFields?: readonly string[] | null;
  chapterFields?: readonly string[] | null;
}

/**
 * A Capabilities reply in the shape the client's introspection asks for. The
 * defaults describe the pinned release: every root field the client uses and
 * no per-user download state.
 */
export const capabilitiesData = ({
  version = FAKE_VERSION,
  buildType = 'Stable',
  queryTypeName = 'Query',
  mutationTypeName = 'Mutation',
  queryFields = ROOT_FIELDS.query,
  mutationFields = ROOT_FIELDS.mutation,
  mangaFields = ['id', 'title'],
  chapterFields = ['id', 'name'],
}: FakeSchema = {}): FakeReply => {
  const type = (name: string, names: readonly string[]) => ({
    name,
    fields: names.map((field) => ({ name: field })),
  });
  return graphqlData({
    aboutServer: { name: 'Suwayomi-Server', version, buildType },
    __schema: {
      queryType: { name: queryTypeName },
      mutationType: { name: mutationTypeName },
      types: [
        type(queryTypeName, queryFields),
        type(mutationTypeName, mutationFields),
        ...(mangaFields ? [type('MangaType', mangaFields)] : []),
        ...(chapterFields ? [type('ChapterType', chapterFields)] : []),
        { name: 'String', fields: null },
      ],
    },
  });
};

// The pinned Suwayomi-Server v2.4.2366 ships graphql-java's
// GoodFaithIntrospection. It refuses a request with a root `__schema` or
// `__type` that selects any of these coordinates more than once, or more than
// 500 fields, or fields deeper than 20 levels.
const GOOD_FAITH_ROOTS = ['__schema', '__type'];
const GOOD_FAITH_TYPE_FIELDS = [
  'fields',
  'inputFields',
  'interfaces',
  'possibleTypes',
];
const GOOD_FAITH_COORDINATES = [
  ...GOOD_FAITH_ROOTS.map((field) => `Query.${field}`),
  ...GOOD_FAITH_TYPE_FIELDS.map((field) => `__Type.${field}`),
];
const GOOD_FAITH_MAX_FIELDS = 500;
const GOOD_FAITH_MAX_DEPTH = 20;

/**
 * Lists the good-faith introspection limits a fragment-free document breaks,
 * in a fixed order. It counts written fields; the server merges repeated ones
 * and expands those of an interface or union for each possible type.
 */
export const goodFaithViolations = (document: string): string[] => {
  let ast: DocumentNode;
  try {
    ast = parse(document);
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  let introspects = false;
  let insideIntrospection = false;
  let depth = 0;
  let deepest = 0;
  let total = 0;
  visit(ast, {
    Field: {
      enter(node) {
        depth += 1;
        total += 1;
        deepest = Math.max(deepest, depth);
        const name = node.name.value;
        if (depth === 1) {
          insideIntrospection = GOOD_FAITH_ROOTS.includes(name);
          introspects ||= insideIntrospection;
        }
        const coordinate =
          depth === 1 && insideIntrospection
            ? `Query.${name}`
            : insideIntrospection && GOOD_FAITH_TYPE_FIELDS.includes(name)
              ? `__Type.${name}`
              : undefined;
        if (coordinate) {
          counts.set(coordinate, (counts.get(coordinate) ?? 0) + 1);
        }
      },
      leave() {
        depth -= 1;
      },
    },
  });
  if (!introspects) return [];
  const violations = GOOD_FAITH_COORDINATES.filter(
    (coordinate) => (counts.get(coordinate) ?? 0) > 1
  );
  if (total > GOOD_FAITH_MAX_FIELDS) {
    violations.push(`more than ${GOOD_FAITH_MAX_FIELDS} fields`);
  }
  if (deepest > GOOD_FAITH_MAX_DEPTH) {
    violations.push(`deeper than ${GOOD_FAITH_MAX_DEPTH} levels`);
  }
  return violations;
};

const base64url = (value: string) =>
  Buffer.from(value, 'utf8').toString('base64url');

let tokenSequence = 0;

/** An unsigned JWT-shaped token whose payload carries `exp` in seconds. */
export const createFakeJwt = (claims: {
  exp?: number;
  typ?: string;
}): string => {
  tokenSequence += 1;
  return [
    base64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64url(JSON.stringify({ ...claims, jti: `fake-${tokenSequence}` })),
    base64url('fake-signature'),
  ].join('.');
};

const toReply = async (
  reply: FakeReply | FakeHandler,
  request: FakeRequest
): Promise<FakeReply> => (typeof reply === 'function' ? reply(request) : reply);

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_048_576) {
        reject(new Error('Fake request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const send = async (response: ServerResponse, reply: FakeReply) => {
  if (reply.delayMs) await sleep(reply.delayMs);
  if (reply.hang || response.destroyed) return;

  const headers: Record<string, string> = { ...reply.headers };
  const hasType = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'content-type'
  );
  if (reply.chunks) {
    response.writeHead(reply.status ?? 200, headers);
    for (const [index, chunk] of reply.chunks.entries()) {
      if (reply.stallAfterChunks !== undefined) {
        if (index >= reply.stallAfterChunks) return;
      }
      if (reply.dropAfterChunks !== undefined) {
        if (index >= reply.dropAfterChunks) {
          response.destroy();
          return;
        }
      }
      if (response.destroyed) return;
      response.write(chunk);
      if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
    }
    response.end();
    return;
  }

  let payload: Buffer | undefined;
  if (Buffer.isBuffer(reply.body)) {
    payload = reply.body;
  } else if (typeof reply.body === 'string') {
    payload = Buffer.from(reply.body, 'utf8');
    if (!hasType) headers['Content-Type'] = 'text/plain';
  } else if (reply.body !== undefined) {
    payload = Buffer.from(JSON.stringify(reply.body), 'utf8');
    if (!hasType) headers['Content-Type'] = 'application/json';
  }
  response.writeHead(reply.status ?? 200, headers);
  response.end(payload);
};

export const startFakeSuwayomi = async (
  options: FakeSuwayomiOptions = {}
): Promise<FakeSuwayomi> => {
  const mode = options.mode ?? 'UI_LOGIN';
  const username = options.username ?? 'fake-user';
  const password = options.password ?? randomUUID();
  const basePath = (options.basePath ?? '/').replace(/\/?$/, '/');
  const tokens = new Map<
    string,
    { type: 'access' | 'refresh'; expiresAt: number; valid: boolean }
  >();
  const operationReplies = new Map<string, (FakeReply | FakeHandler)[]>();
  const routeReplies = new Map<string, (FakeReply | FakeHandler)[]>();
  const requests: FakeRequest[] = [];
  const counters = { logins: 0, refreshes: 0 };

  const nextReply = (
    replies: Map<string, (FakeReply | FakeHandler)[]>,
    key: string
  ) => {
    const queue = replies.get(key);
    if (!queue?.length) return undefined;
    return queue.length > 1 ? queue.shift() : queue[0];
  };

  const issue = (type: 'access' | 'refresh') => {
    const ttl =
      type === 'access'
        ? (options.accessTtlSeconds ?? 300)
        : (options.refreshTtlSeconds ?? 3_600);
    const exp = Math.floor(Date.now() / 1_000) + ttl;
    const token = createFakeJwt({ exp, typ: type });
    tokens.set(token, { type, expiresAt: exp * 1_000, valid: true });
    return token;
  };

  const tokenState = (token: string | undefined) => {
    const state = token ? tokens.get(token) : undefined;
    return state && state.valid && state.expiresAt > Date.now()
      ? state.type
      : undefined;
  };

  const bearer = (headers: IncomingHttpHeaders) => {
    const value = headers.authorization;
    return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
  };

  const basicMatches = (headers: IncomingHttpHeaders) =>
    headers.authorization ===
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  /** Returns a rejection when the request may not proceed. */
  const authorize = (
    request: FakeRequest,
    graphql: boolean
  ): FakeReply | undefined => {
    if (mode === 'NONE') return undefined;
    if (mode === 'BASIC_AUTH') {
      return basicMatches(request.headers)
        ? undefined
        : {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Fake"' },
          };
    }
    const name = request.operationName ?? '';
    if (
      graphql &&
      (PUBLIC_OPERATIONS.has(name) || TOKEN_OPERATIONS.has(name))
    ) {
      return undefined;
    }
    const token = bearer(request.headers);
    if (mode === 'UI_LOGIN' && tokenState(token) === 'refresh') {
      return { status: 400, body: 'Cannot use refresh token to access' };
    }
    if (mode === 'UI_LOGIN' && tokenState(token) === 'access') {
      return undefined;
    }
    return graphql ? graphqlErrors(['Unauthorized']) : { status: 401 };
  };

  const tokenReply = (request: FakeRequest): FakeReply => {
    if (request.operationName === 'Login') {
      if (mode === 'UI_LOGIN' && tokenState(bearer(request.headers))) {
        return graphqlErrors(['Cannot login while already logged-in']);
      }
      const { variables } = request;
      if (variables.username !== username || variables.password !== password) {
        return graphqlErrors(['Incorrect username or password.']);
      }
      counters.logins += 1;
      return graphqlData({
        login: { accessToken: issue('access'), refreshToken: issue('refresh') },
      });
    }
    counters.refreshes += 1;
    const refreshToken = String(request.variables.refreshToken ?? '');
    return tokenState(refreshToken) === 'refresh'
      ? graphqlData({ refreshToken: { accessToken: issue('access') } })
      : graphqlErrors([syntheticFailure('refresh token rejected')]);
  };

  const defaultReply = (request: FakeRequest): FakeReply => {
    switch (request.operationName) {
      case 'Probe':
        return graphqlData({
          aboutServer: {
            name: 'Suwayomi-Server',
            version: FAKE_VERSION,
            buildType: 'Stable',
          },
        });
      case 'AuthTest':
        return graphqlData({ downloadStatus: { state: 'STOPPED' } });
      default:
        return graphqlErrors([syntheticFailure('no scripted reply')]);
    }
  };

  const handle = async (
    incoming: IncomingMessage,
    response: ServerResponse
  ) => {
    response.on('error', () => undefined);
    const closed = new Promise<boolean>((resolve) =>
      response.once('close', () => resolve(response.writableFinished))
    );
    const raw = await readBody(incoming).catch(() => '');
    const url = incoming.url ?? '/';
    const path = new URL(url, 'http://fake').pathname;
    const request: FakeRequest = {
      method: incoming.method ?? 'GET',
      url,
      headers: incoming.headers,
      variables: {},
      closed,
    };
    requests.push(request);

    if (!path.startsWith(basePath)) {
      await send(response, { status: 404 });
      return;
    }
    const route = path.slice(basePath.length);
    if (route === 'api/graphql' && request.method === 'POST') {
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        request.operationName =
          typeof body.operationName === 'string'
            ? body.operationName
            : undefined;
        request.query = typeof body.query === 'string' ? body.query : undefined;
        request.variables =
          typeof body.variables === 'object' && body.variables !== null
            ? (body.variables as Record<string, unknown>)
            : {};
      } catch {
        await send(response, { status: 400, body: 'Bad request' });
        return;
      }
      const rejection = authorize(request, true);
      if (rejection) {
        await send(response, rejection);
        return;
      }
      const violations = request.query
        ? goodFaithViolations(request.query)
        : [];
      if (violations.length > 0) {
        await send(
          response,
          graphqlErrors([`Bad-faith introspection: ${violations.join(', ')}`])
        );
        return;
      }
      const scripted = nextReply(operationReplies, request.operationName ?? '');
      const reply = scripted
        ? await toReply(scripted, request)
        : TOKEN_OPERATIONS.has(request.operationName ?? '')
          ? tokenReply(request)
          : defaultReply(request);
      await send(response, reply);
      return;
    }

    const rejection = authorize(request, false);
    if (rejection) {
      await send(response, rejection);
      return;
    }
    const scripted = nextReply(routeReplies, `${request.method} /${route}`);
    await send(
      response,
      scripted ? await toReply(scripted, request) : { status: 404 }
    );
  };

  const server = createServer((incoming, response) => {
    handle(incoming, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}${basePath}`,
    origin,
    requests,
    get logins() {
      return counters.logins;
    },
    get refreshes() {
      return counters.refreshes;
    },
    onOperation(name, ...replies) {
      operationReplies.set(name, replies);
    },
    onRoute(method, path, ...replies) {
      routeReplies.set(`${method.toUpperCase()} ${path}`, replies);
    },
    operations(name) {
      return requests.filter((request) => request.operationName === name);
    },
    issuedTokens() {
      return [...tokens.keys()];
    },
    expireAccessTokens() {
      for (const state of tokens.values()) {
        if (state.type === 'access') state.valid = false;
      }
    },
    expireRefreshTokens() {
      for (const state of tokens.values()) {
        if (state.type === 'refresh') state.valid = false;
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export interface FakeLibraryChapter {
  chapterNumber: number;
  isDownloaded: boolean;
}

/** One library manga, with invented values only. */
export interface FakeLibraryManga {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  /** Defaults to chapter 1 to `chapterCount`, the first `downloadCount` downloaded. */
  chapters?: FakeLibraryChapter[];
  /** Default to what `chapters` says; set them apart to fake a stale count. */
  chapterCount?: number;
  downloadCount?: number;
  hasDuplicateChapters?: boolean;
  trackRecords?: { trackerId: number; remoteId: string }[];
}

export interface FakeLibrary {
  mangas: FakeLibraryManga[];
  /** Page size of LibraryPage; the client asks for 100. */
  pageSize?: number;
}

/** Builds a library manga with invented values; `id` decides the rest. */
export const fakeLibraryManga = (
  id: number,
  overrides: Partial<FakeLibraryManga> = {}
): FakeLibraryManga => ({
  id,
  sourceId: '0',
  url: `/fake-library/${id}`,
  title: `Fake Library Title ${id}`,
  ...overrides,
});

export const fakeLibraryChapters = (manga: FakeLibraryManga) =>
  manga.chapters ??
  Array.from({ length: manga.chapterCount ?? 0 }, (_, index) => ({
    chapterNumber: index + 1,
    isDownloaded: index < (manga.downloadCount ?? 0),
  }));

const libraryNode = (manga: FakeLibraryManga) => {
  const chapters = fakeLibraryChapters(manga);
  return {
    id: manga.id,
    sourceId: manga.sourceId,
    url: manga.url,
    title: manga.title,
    downloadCount:
      manga.downloadCount ??
      chapters.filter((chapter) => chapter.isDownloaded).length,
    hasDuplicateChapters: manga.hasDuplicateChapters ?? false,
    chapters: { totalCount: manga.chapterCount ?? chapters.length },
  };
};

const requestedIds = (request: FakeRequest) =>
  new Set(
    (Array.isArray(request.variables.ids) ? request.variables.ids : []).map(
      Number
    )
  );

/**
 * Serves Capabilities and the library-scan reads from `library`, which tests
 * may change between scans. Pages use keyset cursors (the last ID), as the
 * pinned server does for `order: [{ by: ID }]`.
 */
export const serveFakeLibrary = (
  server: FakeSuwayomi,
  library: FakeLibrary
): void => {
  server.onOperation(
    'Capabilities',
    capabilitiesData({ mangaFields: ['id', 'title', 'trackRecords'] })
  );
  server.onOperation('LibraryPage', (request) => {
    const sorted = [...library.mangas].sort((a, b) => a.id - b.id);
    const after =
      typeof request.variables.after === 'string'
        ? Number(request.variables.after)
        : -1;
    const remaining = sorted.filter((manga) => manga.id > after);
    const page = remaining.slice(0, library.pageSize ?? 100);
    const last = page[page.length - 1];
    return graphqlData({
      mangas: {
        totalCount: sorted.length,
        pageInfo: {
          hasNextPage: remaining.length > page.length,
          endCursor: last ? String(last.id) : null,
        },
        nodes: page.map(libraryNode),
      },
    });
  });
  server.onOperation('LibraryTrackRecords', (request) => {
    const ids = requestedIds(request);
    return graphqlData({
      mangas: {
        nodes: library.mangas
          .filter((manga) => ids.has(manga.id))
          .map((manga) => ({
            id: manga.id,
            trackRecords: { nodes: manga.trackRecords ?? [] },
          })),
      },
    });
  });
  server.onOperation('LibraryChapterStates', (request) => {
    const ids = requestedIds(request);
    return graphqlData({
      mangas: {
        nodes: library.mangas
          .filter((manga) => ids.has(manga.id))
          .map((manga) => {
            const chapters = fakeLibraryChapters(manga);
            return {
              id: manga.id,
              chapters: { totalCount: chapters.length, nodes: chapters },
            };
          }),
      },
    });
  });
};
