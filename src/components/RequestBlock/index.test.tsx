import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { MangaRequestScopeSummary } from '@server/lib/mangaRequests';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RequestBlock from '.';

const state = vi.hoisted(() => ({
  keys: [] as unknown[],
  responses: {} as Record<string, { data?: unknown }>,
  granted: [] as number[],
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    return (key && state.responses[key]) ?? {};
  },
  mutate: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: vi.fn(), delete: vi.fn() } }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({
      show,
      type,
      mangaId,
      tmdbId,
    }: {
      show?: boolean;
      type?: string;
      mangaId?: number;
      tmdbId?: number;
    }) =>
      show ? (
        <div
          data-testid="request-modal"
          data-type={type}
          data-manga-id={mangaId}
          data-tmdb-id={tmdbId}
        />
      ) : null,
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content: string;
  }) => <span title={content}>{children}</span>,
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      user: { id: 7 },
      hasPermission: (required: number) => state.granted.includes(required),
    }),
  };
});

const scope = (
  values: Partial<MangaRequestScopeSummary> = {}
): MangaRequestScopeSummary => ({
  scope: MangaRequestScope.ALL_AT_DISPATCH,
  latestCount: null,
  rangeStart: null,
  rangeEnd: null,
  awaitingBinding: false,
  ...values,
});

const blockRequest = (values: Partial<MediaRequest> = {}) =>
  ({
    id: 41,
    type: 'manga',
    status: MediaRequestStatus.APPROVED,
    is4k: false,
    seasons: [],
    serverId: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    requestedBy: { id: 7, displayName: 'Sample Reader', avatar: '/a.png' },
    media: {
      id: 9,
      tmdbId: 4242,
      status: MediaStatus.PENDING,
      identifiers: [{ provider: 'anilist', value: '30013' }],
    },
    ...values,
  }) as unknown as MediaRequest;

const withScope = (
  value: MangaRequestScopeSummary,
  status?: MediaRequestStatus
) => {
  state.responses['/api/v1/request/41'] = {
    data: {
      ...blockRequest(),
      ...(status !== undefined ? { status } : {}),
      mangaScope: value,
    },
  };
};

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.keys = [];
  state.responses = {};
  state.granted = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async (request: MediaRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <RequestBlock request={request} />
      </IntlProvider>
    )
  );
};

it('shows the waiting status in place of Approved while a source is missing', async () => {
  withScope(
    scope({
      scope: MangaRequestScope.RANGE,
      rangeStart: 10,
      awaitingBinding: true,
    })
  );

  await render(blockRequest());

  expect(state.keys).toContain('/api/v1/request/41');
  expect(host.textContent).toContain('Waiting for a source');
  expect(host.textContent).not.toContain('Approved');
  expect(host.textContent).not.toContain('administrator');
  expect(host.textContent).toContain('Chapters10 onward');
});

it('keeps Approved once a source is linked', async () => {
  withScope(scope());

  await render(blockRequest());

  expect(host.textContent).toContain('Approved');
  expect(host.textContent).not.toContain('Waiting for a source');
  expect(host.textContent).toContain('ChaptersAll');
});

it('takes the status from the block, not the fetched copy', async () => {
  withScope(scope({ awaitingBinding: true }), MediaRequestStatus.APPROVED);

  await render(blockRequest({ status: MediaRequestStatus.PENDING }));

  expect(host.textContent).toContain('Pending');
  expect(host.textContent).not.toContain('Waiting for a source');
});

it('shows request managers the waiting-for-a-source hint', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];
  withScope(scope({ awaitingBinding: true }));

  await render(blockRequest());

  expect(host.textContent).toContain(
    'Waiting for a sourceSeerrNG is looking for a source; an administrator may need to choose one.'
  );
});

const sourceLink = () =>
  host.querySelector('a[href^="/settings/manga-sources"]');
const withWaitingCopy = (serverId?: number) => {
  state.responses['/api/v1/request/41'] = {
    data: {
      ...blockRequest({ serverId }),
      mangaScope: scope({ awaitingBinding: true }),
    },
  };
};

it.each([0, 4])(
  'links administrators from the waiting hint to instance %i',
  async (serverId) => {
    state.granted = [Permission.ADMIN, Permission.MANAGE_REQUESTS];
    withWaitingCopy(serverId);

    await render(blockRequest());

    expect(sourceLink()?.getAttribute('href')).toBe(
      `/settings/manga-sources?anilistId=30013&instanceId=${serverId}`
    );
    expect(sourceLink()?.textContent).toBe('Choose Source');
  }
);

it.each([
  ['request managers', [Permission.MANAGE_REQUESTS], 0],
  [
    'a request with no instance',
    [Permission.ADMIN, Permission.MANAGE_REQUESTS],
    undefined,
  ],
])('leaves out Choose Source for %s', async (_case, granted, serverId) => {
  state.granted = granted;
  withWaitingCopy(serverId);

  await render(blockRequest());

  expect(host.textContent).toContain(
    'an administrator may need to choose one.'
  );
  expect(sourceLink()).toBeNull();
});

it('opens the manga edit modal and asks no Servarr service', async () => {
  await render(blockRequest({ status: MediaRequestStatus.PENDING }));

  await act(async () =>
    host
      .querySelector('[title="Edit Request"] button')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );

  const modal = host.querySelector('[data-testid="request-modal"]');
  expect(modal?.getAttribute('data-type')).toBe('manga');
  expect(modal?.getAttribute('data-manga-id')).toBe('30013');
  expect(modal?.hasAttribute('data-tmdb-id')).toBe(false);
  expect(
    state.keys.filter((key) => String(key).startsWith('/api/v1/service/'))
  ).toEqual([]);
});

it('leaves other media types without the manga lookup', async () => {
  await render(blockRequest({ type: 'movie' } as Partial<MediaRequest>));

  expect(state.keys).not.toContain('/api/v1/request/41');
  expect(state.keys).toContain('/api/v1/service/radarr');
  expect(host.textContent).toContain('Approved');
});
