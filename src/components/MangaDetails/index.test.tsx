import { MediaStatus } from '@server/constants/media';
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
  keys: [] as unknown[],
  post: vi.fn(),
  revalidate: vi.fn(),
  addToast: vi.fn(),
  granted: [] as number[],
}));
vi.mock('swr', () => ({
  default: (key: unknown) => {
    state.keys.push(key);
    return { ...state.swr, mutate: state.revalidate };
  },
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: { mangaId: '30013' } }),
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
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      hasPermission: (required: number) => state.granted.includes(required),
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
  state.keys = [];
  state.post.mockReset();
  state.revalidate.mockReset();
  state.addToast.mockReset();
  state.granted = [Permission.REQUEST, Permission.MANAGE_BLOCKLIST];
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
