import type { MangaScopedRequest } from '@app/utils/mangaRequestScope';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MangaRequestScopeSummary } from '@server/lib/mangaRequests';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RequestStatusCard } from '.';

const state = vi.hoisted(() => ({
  keys: [] as unknown[],
  responses: {} as Record<string, { data?: unknown }>,
  granted: [] as number[],
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    return { ...((key && state.responses[key]) ?? {}), mutate: vi.fn() };
  },
  useSWRConfig: () => ({ mutate: vi.fn(), cache: new Map() }),
}));
vi.mock('axios', () => ({ default: { post: vi.fn(), put: vi.fn() } }));
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
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: {} }),
}));
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

type Item = ComponentProps<typeof RequestStatusCard>['item'];

const mangaItem = (
  values: Partial<MangaScopedRequest> = {},
  stage = 'approved'
): Item =>
  ({
    request: {
      id: 41,
      type: 'manga',
      status: MediaRequestStatus.APPROVED,
      is4k: false,
      seasons: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      requestedBy: { id: 7, displayName: 'Sample Reader', avatar: '/a.png' },
      media: {
        id: 9,
        tmdbId: 0,
        status: MediaStatus.PROCESSING,
        identifiers: [{ provider: 'anilist', value: '30013' }],
      },
      mangaScope: scope(),
      ...values,
    },
    status: {
      stage,
      message: 'Approved for processing.',
      percent: null,
      size: null,
      sizeLeft: null,
      estimatedCompletionTime: null,
      downloadCount: 0,
      downloadId: null,
      service: null,
      isTerminal: false,
      needsAttention: false,
      retryable: false,
    },
    canRemove: false,
  }) as unknown as Item;

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
  state.responses = {
    '/api/v1/manga/30013': {
      data: {
        id: 30013,
        mediaType: 'manga',
        title: 'Sample Manga',
        startYear: 1994,
        posterPath: 'https://s4.anilist.co/file/cover.jpg',
        genres: [],
      },
    },
  };
  state.granted = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async (item: Item, isAdminView = false) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <RequestStatusCard
          item={item}
          isAdminView={isAdminView}
          onRetry={vi.fn()}
          isRetrying={false}
          onDelete={vi.fn()}
          isDeleting={false}
          onRemove={vi.fn()}
          isRemoving={false}
          isHistoryOpen={false}
          onToggleHistory={vi.fn()}
        />
      </IntlProvider>
    )
  );
};

const chip = () =>
  host.querySelector('.request-status-action-row [tabindex="0"]');

it('shows a manga request with its title, artwork, link and chapters', async () => {
  state.responses['/api/v1/manga/30013'] = {
    data: {
      ...(state.responses['/api/v1/manga/30013'].data as object),
      genres: ['Drama', 'Comedy', 'Mystery', 'Sports'],
    },
  };
  await render(
    mangaItem({
      mangaScope: scope({
        scope: MangaRequestScope.LATEST_N,
        latestCount: 25,
      }),
    })
  );

  expect(state.keys).toContain('/api/v1/manga/30013');
  const links = [...host.querySelectorAll('a')].map((link) =>
    link.getAttribute('href')
  );
  expect(links).toContain('/manga/30013');
  expect(host.textContent).toContain('Sample Manga (1994)');
  expect(host.textContent).toContain('Manga · Manga');
  expect(host.textContent).toContain('Chapters:Latest 25');
  // No discover page filters manga by genre, so the names aren't links.
  expect(host.textContent).toContain('Genres:Drama, Comedy, Mystery');
  expect(host.textContent).not.toContain('Sports');
  expect(links.some((href) => href?.includes('genre'))).toBe(false);
  expect(host.textContent).not.toContain('Director');
  expect(host.textContent).not.toContain('Studio');
  expect(
    [...host.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  ).toContain('/imageproxy/anilist/file/cover.jpg');
});

it('names a manga request without an AniList ID neutrally', async () => {
  await render(mangaItem({ media: { identifiers: [] } } as never));

  expect(
    state.keys.some((key) => String(key).startsWith('/api/v1/manga'))
  ).toBe(false);
  expect(host.textContent).toContain('Unknown title');
  expect(host.textContent).not.toContain('MANGA #');
});

it('shows the waiting status in place of Approved while a source is missing', async () => {
  await render(mangaItem({ mangaScope: scope({ awaitingBinding: true }) }));

  expect(chip()?.textContent).toBe('Waiting for a source');
  expect(chip()?.className).toContain('app-button-default');
  expect(chip()?.getAttribute('aria-label')).toBe(
    'Waiting for a source: Approved for processing.'
  );

  await render(mangaItem());
  expect(chip()?.textContent).toBe('Approved');

  await render(
    mangaItem(
      {
        status: MediaRequestStatus.PENDING,
        mangaScope: scope({ awaitingBinding: true }),
      },
      'requested'
    )
  );
  expect(chip()?.textContent).toBe('Requested');
});

it('shows request managers the waiting-for-a-source hint', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];

  await render(mangaItem({ mangaScope: scope({ awaitingBinding: true }) }));

  expect(chip()?.getAttribute('aria-label')).toBe(
    'Waiting for a source: SeerrNG is looking for a source; an administrator may need to choose one.'
  );
});

const sourceButton = () =>
  host.querySelector(
    '.request-status-action-row a[href^="/settings/manga-sources"]'
  );
const waitingScope = scope({ awaitingBinding: true });

it.each([0, 6])(
  'puts Choose Source after the status for administrators on instance %i',
  async (serverId) => {
    state.granted = [Permission.ADMIN, Permission.MANAGE_REQUESTS];

    await render(mangaItem({ serverId, mangaScope: waitingScope }), true);

    expect(sourceButton()?.getAttribute('href')).toBe(
      `/settings/manga-sources?anilistId=30013&instanceId=${serverId}`
    );
    expect(sourceButton()?.className).toBe(
      'app-button app-button-manage button-sm'
    );
    expect(sourceButton()?.textContent).toBe('Choose Source');
    expect(
      sourceButton()?.querySelector('svg')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(sourceButton()?.previousElementSibling?.contains(chip())).toBe(true);
  }
);

it.each<[string, number[], Partial<MangaScopedRequest>]>([
  [
    'request managers',
    [Permission.MANAGE_REQUESTS],
    { serverId: 0, mangaScope: waitingScope },
  ],
  [
    'a request with no instance',
    [Permission.ADMIN, Permission.MANAGE_REQUESTS],
    { mangaScope: waitingScope },
  ],
  [
    'a title with no AniList ID',
    [Permission.ADMIN, Permission.MANAGE_REQUESTS],
    {
      serverId: 0,
      mangaScope: waitingScope,
      media: { identifiers: [] } as never,
    },
  ],
  [
    'a request with a source',
    [Permission.ADMIN, Permission.MANAGE_REQUESTS],
    { serverId: 0 },
  ],
])('leaves out Choose Source for %s', async (_case, granted, values) => {
  state.granted = granted;

  await render(mangaItem(values), true);

  expect(chip()).toBeTruthy();
  expect(sourceButton()).toBeNull();
});

it('opens the manga edit modal from a pending request', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];
  await render(
    mangaItem({ status: MediaRequestStatus.PENDING }, 'requested'),
    true
  );

  const edit = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Edit'
  );
  await act(async () =>
    edit?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );

  const modal = host.querySelector('[data-testid="request-modal"]');
  expect(modal?.getAttribute('data-type')).toBe('manga');
  expect(modal?.getAttribute('data-manga-id')).toBe('30013');
  expect(modal?.hasAttribute('data-tmdb-id')).toBe(false);
  expect(modal?.getAttribute('data-edit-request')).toBe('41');
});
