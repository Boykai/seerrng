import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import type { MangaDetails as MangaDetailsType } from '@server/models/Manga';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MangaDetails from '.';

const state = vi.hoisted(() => ({
  swr: {} as { data?: unknown; error?: unknown },
  byKey: {} as Record<string, { data?: unknown; error?: unknown }>,
  keys: [] as unknown[],
  post: vi.fn(),
  revalidate: vi.fn(),
  addToast: vi.fn(),
  granted: [] as number[],
  user: undefined as { id: number } | undefined,
  settings: {} as { suwayomiEnabled?: boolean },
}));
vi.mock('swr', () => ({
  default: (key: unknown) => {
    state.keys.push(key);
    const response =
      typeof key === 'string' && key.startsWith('/api/v1/request/')
        ? (state.byKey[key] ?? {})
        : state.swr;
    return { ...response, mutate: state.revalidate };
  },
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { mangaId: '30013' } }),
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({
      show,
      type,
      mangaId,
      editRequest,
    }: {
      show?: boolean;
      type?: string;
      mangaId?: number;
      editRequest?: { id: number };
    }) =>
      show ? (
        <div
          data-testid="request-modal"
          data-type={type}
          data-manga-id={mangaId}
          data-edit-request={editRequest?.id}
        />
      ) : null,
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  default: () => <div data-testid="loading" />,
}));
vi.mock('@app/pages/_error', () => ({
  default: ({ statusCode }: { statusCode: number }) => (
    <div data-testid="error-page">{statusCode}</div>
  ),
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
vi.mock('@app/components/MediaDetails/MediaDetailArtwork', () => ({
  default: ({ src }: { src: string }) => <div data-artwork={src} />,
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
vi.mock('@app/components/ExternalBlocklistModal', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="confirm-blocklist" onClick={onComplete}>
      confirm
    </button>
  ),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      user: state.user,
      hasPermission: (
        required: number | number[],
        options?: { type?: 'and' | 'or' }
      ) =>
        Array.isArray(required)
          ? options?.type === 'or'
            ? required.some((value) => state.granted.includes(value))
            : required.every((value) => state.granted.includes(value))
          : state.granted.includes(required),
    }),
  };
});

const details = (values: Partial<MangaDetailsType> = {}): MangaDetailsType => ({
  id: 30013,
  mediaType: 'manga',
  provider: 'anilist',
  title: 'Sample Manga',
  titles: {
    romaji: 'Sanpuru Manga',
    english: 'Sample Manga',
    native: 'サンプル',
  },
  synonyms: ['Sample Alias'],
  format: 'MANGA',
  status: 'FINISHED',
  chapters: 120,
  volumes: 12,
  isAdult: false,
  idMal: 513,
  posterPath: 'https://s4.anilist.co/file/cover.jpg',
  backdropPath: 'https://s4.anilist.co/file/banner.jpg',
  genres: ['Adventure', 'Drama'],
  startYear: 1994,
  description: '<p>A <b>sanitized</b> story.</p>',
  tags: [{ name: 'Pirates', rank: 90 }],
  story: [{ id: 1, name: 'Story Writer' }],
  art: [{ id: 2, name: 'Art Illustrator' }],
  siteUrl: 'https://anilist.co/manga/30013',
  startDate: '1994-07-22',
  endDate: '1999-03',
  ...values,
});

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
  state.swr = { data: details() };
  state.byKey = {};
  state.keys = [];
  state.post.mockReset();
  state.revalidate.mockReset();
  state.addToast.mockReset();
  state.granted = [Permission.REQUEST, Permission.MANAGE_BLOCKLIST];
  state.user = { id: 7 };
  state.settings = {};
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <MangaDetails />
      </IntlProvider>
    )
  );
};

const detailValue = (label: string) =>
  [...host.querySelectorAll('dt')].find(
    (term) => term.textContent === `${label}:`
  )?.nextElementSibling?.textContent;

it('renders the manga fields, title variants and proxied artwork', async () => {
  await render();

  expect(state.keys).toContain('/api/v1/manga/30013');
  expect(host.querySelector('h1')?.textContent).toBe('Sample Manga (1994)');
  expect(detailValue('Format')).toBe('Manga');
  expect(detailValue('Status')).toBe('Finished');
  expect(detailValue('Chapters')).toBe('120');
  expect(detailValue('Volumes')).toBe('12');
  expect(detailValue('Start Date')).toBe('Jul 22, 1994');
  expect(detailValue('End Date')).toBe('March 1999');
  expect(detailValue('Story')).toBe('Story Writer');
  expect(detailValue('Art')).toBe('Art Illustrator');
  expect(detailValue('Genres')).toBe('Adventure, Drama');
  expect(detailValue('Tags')).toBe('Pirates');
  expect(detailValue('Romaji Title')).toBe('Sanpuru Manga');
  expect(detailValue('English Title')).toBe('Sample Manga');
  expect(detailValue('Native Title')).toBe('サンプル');
  expect(detailValue('Synonyms')).toBe('Sample Alias');
  expect(host.querySelector('img')?.getAttribute('src')).toBe(
    '/imageproxy/anilist/file/cover.jpg'
  );
  expect(
    host.querySelector('[data-artwork]')?.getAttribute('data-artwork')
  ).toBe('/imageproxy/anilist/file/banner.jpg');
});

it('shows a placeholder for missing values and a year-only start date', async () => {
  state.swr = {
    data: details({
      format: undefined,
      status: undefined,
      chapters: undefined,
      volumes: undefined,
      idMal: undefined,
      backdropPath: undefined,
      description: undefined,
      startDate: '1994',
      endDate: undefined,
      story: [],
      art: [],
      tags: [],
      synonyms: [],
    }),
  };
  await render();

  expect(detailValue('Format')).toBe('Not available');
  expect(detailValue('Chapters')).toBe('Not available');
  expect(detailValue('Start Date')).toBe('1994');
  expect(detailValue('End Date')).toBe('Not available');
  expect(detailValue('Story')).toBe('Not available');
  expect(host.textContent).toContain('Overview unavailable');
  expect(
    host.querySelector('[data-artwork]')?.getAttribute('data-artwork')
  ).toBe('/imageproxy/anilist/file/cover.jpg');
  expect(host.querySelector('a[href*="myanimelist.net"]')).toBeNull();
});

it('renders only the sanitized description as HTML', async () => {
  state.swr = {
    data: details({
      title: '<i>Escaped Title</i>',
      genres: ['<b>Escaped Genre</b>'],
    }),
  };
  await render();

  const description = host.querySelector('[data-testid="manga-description"]');
  expect(description?.innerHTML).toBe('<p>A <b>sanitized</b> story.</p>');
  expect(host.querySelector('h1')?.textContent).toBe(
    '<i>Escaped Title</i> (1994)'
  );
  expect(detailValue('Genres')).toBe('<b>Escaped Genre</b>');
  expect(host.querySelectorAll('b')).toHaveLength(1);
  expect(host.querySelectorAll('i')).toHaveLength(0);
});

it('links only to AniList and MyAnimeList in a new tab', async () => {
  await render();

  const links = [...host.querySelectorAll('a')].map((link) => ({
    href: link.getAttribute('href'),
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel'),
    text: link.textContent,
  }));
  expect(links).toEqual([
    {
      href: 'https://anilist.co/manga/30013',
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'View on AniList',
    },
    {
      href: 'https://myanimelist.net/manga/513',
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'View on MyAnimeList',
    },
  ]);
});

it('renders no request action', async () => {
  state.granted = [
    Permission.ADMIN,
    Permission.REQUEST,
    Permission.REQUEST_MANGA,
    Permission.MANAGE_BLOCKLIST,
  ];
  await render();

  expect(host.textContent).not.toMatch(/request/i);
  expect(
    [...host.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label')
    )
  ).toEqual(['Add to Blocklist']);
});

it('blocklists the manga by its AniList id for blocklist managers', async () => {
  state.post.mockResolvedValue({ status: 201 });
  await render();

  await act(async () => {
    host
      .querySelector('button[aria-label="Add to Blocklist"]')!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector('[data-testid="confirm-blocklist"]')!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  expect(state.post).toHaveBeenCalledWith('/api/v1/blocklist', {
    externalId: '30013',
    externalProvider: 'anilist',
    mediaType: 'manga',
    title: 'Sample Manga',
  });
  expect(state.addToast).toHaveBeenCalledWith(expect.anything(), {
    appearance: 'success',
    autoDismiss: true,
  });
  expect(state.revalidate).toHaveBeenCalled();
});

it('hides the blocklist action from other users and disables it once blocklisted', async () => {
  state.granted = [Permission.REQUEST];
  await render();
  expect(
    host.querySelector('button[aria-label="Add to Blocklist"]')
  ).toBeNull();

  state.granted = [Permission.MANAGE_BLOCKLIST];
  state.swr = {
    data: details({
      mediaInfo: {
        status: MediaStatus.BLOCKLISTED,
      } as MangaDetailsType['mediaInfo'],
    }),
  };
  await render();
  expect(
    host
      .querySelector('button[aria-label="Add to Blocklist"]')
      ?.hasAttribute('disabled')
  ).toBe(true);
  expect(
    host.querySelector('span[title="This title is already blocklisted."]')
  ).toBeTruthy();
});

it('shows the not-found page when the manga is unknown or excluded', async () => {
  state.swr = { error: { response: { status: 404 } } };
  await render();

  expect(host.querySelector('[data-testid="error-page"]')?.textContent).toBe(
    '404'
  );
});

const availabilityCell = () =>
  [...host.querySelectorAll('dt')].find(
    (term) => term.textContent === 'Availability:'
  )?.nextElementSibling;

it.each([
  [MediaStatus.AVAILABLE, false, 'Available', 'available'],
  [MediaStatus.AVAILABLE, true, 'Available', 'available'],
  [MediaStatus.PARTIALLY_AVAILABLE, true, 'Partially Available', 'available'],
  [MediaStatus.UNKNOWN, true, 'In Suwayomi Library', 'processing'],
  [undefined, true, 'In Suwayomi Library', 'processing'],
])(
  'shows status %s with the library marker %s as %s',
  async (status, inSuwayomiLibrary, text, tone) => {
    state.swr = {
      data: details({
        inSuwayomiLibrary,
        mediaInfo:
          status === undefined
            ? undefined
            : ({ status } as MangaDetailsType['mediaInfo']),
      }),
    };
    await render();

    expect(availabilityCell()?.textContent).toBe(text);
    expect(
      availabilityCell()
        ?.querySelector('[data-availability-tone]')
        ?.getAttribute('data-availability-tone')
    ).toBe(tone);
  }
);

it.each([
  ['no library match', undefined, undefined],
  ['an unknown status without the marker', MediaStatus.UNKNOWN, false],
  ['a blocklisted title in the library', MediaStatus.BLOCKLISTED, true],
])('shows no availability row for %s', async (_case, status, marker) => {
  state.swr = {
    data: details({
      inSuwayomiLibrary: marker,
      mediaInfo:
        status === undefined
          ? undefined
          : ({ status } as MangaDetailsType['mediaInfo']),
    }),
  };
  await render();

  expect(availabilityCell()).toBeUndefined();
  expect(host.textContent).not.toContain('Suwayomi');
});

const buttonLabels = () =>
  [...host.querySelectorAll('button')].map(
    (button) => button.getAttribute('aria-label') ?? button.textContent
  );

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
};

const requestRow = () =>
  [...host.querySelectorAll('dt')].find(
    (term) => term.textContent === 'Request:'
  )?.nextElementSibling?.textContent;

const withRequest = (
  status: MediaRequestStatus,
  requestedBy = 7,
  mediaStatus = MediaStatus.PENDING
) =>
  details({
    mediaInfo: {
      status: mediaStatus,
      requests: [{ id: 41, status, requestedBy: { id: requestedBy } }],
    } as unknown as MangaDetailsType['mediaInfo'],
  });

it.each([
  ['REQUEST', true, [Permission.REQUEST], true],
  ['REQUEST_MANGA', true, [Permission.REQUEST_MANGA], true],
  ['no request permission', false, [Permission.MANAGE_BLOCKLIST], true],
  ['REQUEST without a Suwayomi server', false, [Permission.REQUEST], false],
])(
  'shows the Request action for %s: %s',
  async (_case, shown, granted, suwayomiEnabled) => {
    state.granted = granted;
    state.settings = { suwayomiEnabled };
    await render();

    expect(host.querySelector('h1')?.textContent).toBe('Sample Manga (1994)');
    expect(buttonLabels().includes('Request')).toBe(shown);
  }
);

it.each([
  [MediaStatus.UNKNOWN, true],
  [MediaStatus.DELETED, true],
  [MediaStatus.PARTIALLY_AVAILABLE, true],
  [MediaStatus.PENDING, false],
  [MediaStatus.PROCESSING, false],
  [MediaStatus.AVAILABLE, false],
  [MediaStatus.BLOCKLISTED, false],
])('offers a request for media status %s: %s', async (status, shown) => {
  state.settings = { suwayomiEnabled: true };
  state.swr = {
    data: details({
      mediaInfo: { status } as MangaDetailsType['mediaInfo'],
    }),
  };
  await render();

  expect(buttonLabels().includes('Request')).toBe(shown);
});

it('opens the manga request modal for the AniList id', async () => {
  state.settings = { suwayomiEnabled: true };
  await render();
  expect(host.querySelector('[data-testid="request-modal"]')).toBeNull();

  await click(
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Request'
    )
  );

  const modal = host.querySelector('[data-testid="request-modal"]');
  expect(modal?.getAttribute('data-type')).toBe('manga');
  expect(modal?.getAttribute('data-manga-id')).toBe('30013');
  expect(modal?.hasAttribute('data-edit-request')).toBe(false);
});

it('opens the own pending request in edit mode instead of offering a new one', async () => {
  state.settings = { suwayomiEnabled: true };
  state.swr = {
    data: withRequest(
      MediaRequestStatus.PENDING,
      7,
      MediaStatus.PARTIALLY_AVAILABLE
    ),
  };
  await render();

  expect(buttonLabels()).not.toContain('Request');
  expect(requestRow()).toBe('Pending');
  expect(
    state.keys.some((key) => String(key).startsWith('/api/v1/request/'))
  ).toBe(false);

  await click(
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'View Request'
    )
  );

  expect(
    host
      .querySelector('[data-testid="request-modal"]')
      ?.getAttribute('data-edit-request')
  ).toBe('41');
});

it("opens another user's request only for request managers", async () => {
  state.settings = { suwayomiEnabled: true };
  state.swr = { data: withRequest(MediaRequestStatus.PENDING, 9) };
  await render();
  expect(buttonLabels()).not.toContain('View Request');
  expect(requestRow()).toBe('Requested');

  state.granted = [Permission.MANAGE_REQUESTS];
  await render();
  expect(buttonLabels()).toContain('View Request');
  expect(requestRow()).toBe('Pending');
});

it.each([
  ['pending', 'after', MediaRequestStatus.PENDING, { id: 7 }],
  ['approved', 'after', MediaRequestStatus.APPROVED, { id: 7 }],
  ['pending', 'before', MediaRequestStatus.PENDING, undefined],
  ['approved', 'before', MediaRequestStatus.APPROVED, undefined],
])(
  "shows another user's %s request as Requested, with no Request button, %s the user loads",
  async (_status, _timing, status, user) => {
    state.settings = { suwayomiEnabled: true };
    state.user = user;
    // Other users' requests arrive without their id or requester.
    state.swr = {
      data: details({
        mediaInfo: {
          status: MediaStatus.PARTIALLY_AVAILABLE,
          requests: [{ status, type: 'manga' }],
        } as unknown as MangaDetailsType['mediaInfo'],
      }),
    };
    await render();

    expect(buttonLabels()).not.toContain('Request');
    expect(buttonLabels()).not.toContain('View Request');
    expect(requestRow()).toBe('Requested');
    expect(
      state.keys.some((key) => String(key).startsWith('/api/v1/request/'))
    ).toBe(false);
  }
);

it('shows Requested to a request manager when two requests are active', async () => {
  state.settings = { suwayomiEnabled: true };
  state.granted = [Permission.REQUEST, Permission.MANAGE_REQUESTS];
  state.swr = {
    data: details({
      mediaInfo: {
        status: MediaStatus.PARTIALLY_AVAILABLE,
        requests: [
          {
            id: 41,
            status: MediaRequestStatus.PENDING,
            requestedBy: { id: 8 },
          },
          {
            id: 42,
            status: MediaRequestStatus.APPROVED,
            requestedBy: { id: 9 },
          },
        ],
      } as unknown as MangaDetailsType['mediaInfo'],
    }),
  };
  await render();

  expect(buttonLabels()).not.toContain('Request');
  expect(buttonLabels()).not.toContain('View Request');
  expect(requestRow()).toBe('Requested');
  expect(
    state.keys.some((key) => String(key).startsWith('/api/v1/request/'))
  ).toBe(false);
});

it.each([
  ['the requester', [Permission.REQUEST], 7, false],
  ['a request manager', [Permission.MANAGE_REQUESTS], 9, true],
])(
  'shows a parked approved request to %s as waiting for a source',
  async (_case, granted, requestedBy, hint) => {
    state.granted = granted;
    state.swr = { data: withRequest(MediaRequestStatus.APPROVED, requestedBy) };
    state.byKey['/api/v1/request/41'] = {
      data: {
        id: 41,
        type: 'manga',
        status: MediaRequestStatus.APPROVED,
        mangaScope: {
          scope: 'ALL_AT_DISPATCH',
          latestCount: null,
          rangeStart: null,
          rangeEnd: null,
          awaitingBinding: true,
        },
      },
    };
    await render();

    expect(state.keys).toContain('/api/v1/request/41');
    expect(requestRow()).toContain('Waiting for a source');
    expect(requestRow()).not.toContain('Approved');
    expect(requestRow()?.includes('An administrator must link a source')).toBe(
      hint
    );
  }
);

it('shows an approved request that is not parked as approved', async () => {
  state.swr = { data: withRequest(MediaRequestStatus.APPROVED) };
  state.byKey['/api/v1/request/41'] = {
    data: {
      id: 41,
      type: 'manga',
      status: MediaRequestStatus.APPROVED,
      mangaScope: {
        scope: 'ALL_AT_DISPATCH',
        latestCount: null,
        rangeStart: null,
        rangeEnd: null,
        awaitingBinding: false,
      },
    },
  };
  await render();

  expect(requestRow()).toBe('Approved');
});
