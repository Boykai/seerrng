import type { MangaScopedRequest } from '@app/utils/mangaRequestScope';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MangaRequestScopeSummary } from '@server/lib/mangaRequests';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RequestCard from '.';

const state = vi.hoisted(() => ({
  keys: [] as unknown[],
  responses: {} as Record<string, { data?: unknown; error?: unknown }>,
  granted: [] as number[],
}));
vi.mock('swr', () => ({
  default: (key: string | null, options?: { fallbackData?: unknown }) => {
    state.keys.push(key);
    if (key?.startsWith('/api/v1/request/')) {
      return { data: options?.fallbackData, mutate: vi.fn() };
    }
    return (key && state.responses[key]) ?? {};
  },
  mutate: vi.fn(),
}));
vi.mock('axios', () => ({
  default: { post: vi.fn(), delete: vi.fn(), isAxiosError: () => false },
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({
      show,
      type,
      mangaId,
      tmdbId,
      editRequest,
    }: {
      show?: boolean;
      type?: string;
      mangaId?: number;
      tmdbId?: number;
      editRequest?: { id: number };
    }) =>
      show ? (
        <div
          data-testid="request-modal"
          data-type={type}
          data-manga-id={mangaId}
          data-tmdb-id={tmdbId}
          data-edit-request={editRequest?.id}
        />
      ) : null,
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => undefined, inView: true }),
}));
vi.mock('@app/assets/spinner.svg', () => ({ default: () => null }));
vi.mock('@app/components/Common/CachedImage', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src }: { src: string }) => <img alt="" src={src} />,
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
vi.mock('@app/components/StatusBadge', () => ({
  default: ({
    mediaType,
    externalId,
  }: {
    mediaType?: string;
    externalId?: string;
  }) => (
    <span
      data-testid="status-badge"
      data-media-type={mediaType}
      data-external-id={externalId}
    />
  ),
}));
vi.mock('@app/hooks/useDeepLinks', () => ({ default: () => ({}) }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      user: { id: 7, permissions: 0 },
      hasPermission: (required: number | number[]) =>
        (Array.isArray(required) ? required : [required]).some((value) =>
          state.granted.includes(value)
        ),
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

const mangaRequest = (
  values: Partial<MangaScopedRequest> = {},
  identifiers = [{ provider: 'anilist', value: '30013' }]
) =>
  ({
    id: 41,
    type: 'manga',
    status: MediaRequestStatus.PENDING,
    is4k: false,
    seasons: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    requestedBy: { id: 7, displayName: 'Sample Reader', avatar: '/a.png' },
    media: {
      id: 9,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
      identifiers,
      downloadStatus: [],
      downloadStatus4k: [],
    },
    mangaScope: scope(),
    ...values,
  }) as unknown as MangaScopedRequest;

const title = {
  id: 30013,
  mediaType: 'manga',
  title: 'Sample Manga',
  startYear: 1994,
  posterPath: 'https://s4.anilist.co/file/cover.jpg',
  backdropPath: 'https://s4.anilist.co/file/banner.jpg',
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
  state.responses = { '/api/v1/manga/30013': { data: title } };
  state.granted = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async (request: MangaScopedRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <RequestCard request={request} />
      </IntlProvider>
    )
  );
};

it('loads a manga title from the manga API and links to its page', async () => {
  await render(mangaRequest());

  expect(state.keys).toContain('/api/v1/manga/30013');
  const links = [...host.querySelectorAll('a')].map((link) =>
    link.getAttribute('href')
  );
  expect(links).toContain('/manga/30013');
  expect(host.textContent).toContain('Sample Manga');
  expect(host.textContent).toContain('1994');
  expect(
    [...host.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  ).toEqual(['/imageproxy/anilist/file/cover.jpg']);
});

it.each([
  [scope(), 'All chapters'],
  [
    scope({ scope: MangaRequestScope.LATEST_N, latestCount: 25 }),
    'Latest 25 chapters',
  ],
  [
    scope({ scope: MangaRequestScope.RANGE, rangeStart: 10, rangeEnd: 20 }),
    'Chapters 10–20',
  ],
  [
    scope({ scope: MangaRequestScope.RANGE, rangeStart: 10 }),
    'Chapters 10 onward',
  ],
])('summarizes the requested chapters in one line', async (value, text) => {
  await render(mangaRequest({ mangaScope: value }));

  expect(host.textContent).toContain(`Chapters${text}`);
});

it('shows the waiting status only for approved requests awaiting a source', async () => {
  await render(
    mangaRequest({
      status: MediaRequestStatus.APPROVED,
      mangaScope: scope({ awaitingBinding: true }),
    })
  );
  expect(host.textContent).toContain('Waiting for a source');
  expect(host.textContent).not.toContain('administrator');

  await render(mangaRequest({ mangaScope: scope({ awaitingBinding: true }) }));
  expect(host.textContent).not.toContain('Waiting for a source');

  await render(mangaRequest({ status: MediaRequestStatus.APPROVED }));
  expect(host.textContent).not.toContain('Waiting for a source');
});

it('tells request managers who links a source', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];

  await render(
    mangaRequest({
      status: MediaRequestStatus.APPROVED,
      mangaScope: scope({ awaitingBinding: true }),
    })
  );

  expect(host.textContent).toContain(
    'Waiting for a sourceAn administrator must link a source first.'
  );
});

it('opens the manga edit modal for the requester', async () => {
  state.granted = [Permission.REQUEST_ADVANCED];
  await render(mangaRequest());

  await act(async () =>
    host
      .querySelector('[title="Edit Request"] button')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );

  const modal = host.querySelector('[data-testid="request-modal"]');
  expect(modal?.getAttribute('data-type')).toBe('manga');
  expect(modal?.getAttribute('data-manga-id')).toBe('30013');
  expect(modal?.hasAttribute('data-tmdb-id')).toBe(false);
  expect(modal?.getAttribute('data-edit-request')).toBe('41');
});

it('shows the not-found card when the AniList ID is missing', async () => {
  await render(mangaRequest({}, []));

  expect(
    state.keys.some((key) => String(key).startsWith('/api/v1/manga'))
  ).toBe(false);
  expect(host.querySelector('.animate-pulse')).toBeNull();
  expect(host.textContent).toContain('Manga Not Found');
  const badge = host.querySelector('[data-testid="status-badge"]');
  expect(badge?.getAttribute('data-media-type')).toBe('manga');
  expect(badge?.hasAttribute('data-external-id')).toBe(false);
});

it('keeps the waiting status on the not-found card', async () => {
  state.responses = { '/api/v1/manga/30013': { error: new Error('gone') } };

  await render(
    mangaRequest({
      status: MediaRequestStatus.APPROVED,
      mangaScope: scope({ awaitingBinding: true }),
    })
  );
  expect(host.textContent).toContain('Manga Not Found');
  expect(host.textContent).toContain('Waiting for a source');

  await render(mangaRequest());
  expect(
    host
      .querySelector('[data-testid="status-badge"]')
      ?.getAttribute('data-external-id')
  ).toBe('30013');
});
