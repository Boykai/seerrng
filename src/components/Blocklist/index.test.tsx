import type { MangaDetails } from '@server/models/Manga';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Blocklist from '.';

const state = vi.hoisted(() => ({
  titles: {} as Record<string, { data?: unknown; error?: unknown }>,
  list: {} as unknown,
  keys: [] as (string | null)[],
  revalidate: vi.fn(),
  remove: vi.fn(),
  pinValues: [] as unknown[],
  settings: {} as Record<string, unknown>,
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    return key?.startsWith('/api/v1/blocklist/')
      ? {
          data: state.list,
          error: undefined,
          isValidating: false,
          mutate: state.revalidate,
        }
      : key
        ? (state.titles[key] ?? {})
        : {};
  },
}));
vi.mock('axios', () => ({ default: { delete: state.remove } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, pathname: '/blocklist', replace: vi.fn() }),
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
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: vi.fn(), inView: true }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/PaginationFooter', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/components/BlocklistedTagsBadge', () => ({
  default: () => null,
  compactBlocklistSourceBadgeClass: '',
}));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  CompactSelect: () => null,
  FilterResetButton: ({ label }: { label: string }) => (
    <button type="button">{label}</button>
  ),
  getFilterToggleButtonClass: () => '',
}));
vi.mock('@app/components/Discover/PinnedFilterSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <section data-testid="media-filters">{children}</section>
  ),
}));
vi.mock('@app/components/Discover/MediaFilterOption', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/hooks/useMediaFilterPin', () => ({
  default: ({ values }: { values: unknown }) => {
    state.pinValues.push(values);
    return { available: true, busy: false, error: false, toggle: vi.fn() };
  },
}));
vi.mock('@app/hooks/useSearchActivity', () => ({
  useSearchActivityReporter: () => undefined,
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      hasPermission: (required: number) =>
        required === permissions.Permission.MANAGE_BLOCKLIST,
    }),
  };
});

const mangaItem = {
  tmdbId: 0,
  externalId: '30013',
  externalProvider: 'anilist',
  mediaType: 'manga',
  title: 'Stored Manga Title',
  createdAt: new Date('2026-01-02T03:04:05Z'),
};

const mangaDetails = (): MangaDetails => ({
  id: 30013,
  mediaType: 'manga',
  provider: 'anilist',
  title: 'Sample Manga',
  titles: { romaji: 'Sample Manga' },
  synonyms: [],
  chapters: 120,
  isAdult: false,
  posterPath: 'https://s4.anilist.co/file/cover.jpg',
  genres: ['Adventure', 'Drama'],
  startYear: 1994,
  startDate: '1994-07-22',
  tags: [],
  story: [{ id: 1, name: 'Story Writer' }],
  art: [{ id: 2, name: 'Art Illustrator' }],
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
  state.list = {
    pageInfo: { pages: 1, pageSize: 10, results: 1, page: 1 },
    results: [mangaItem],
    counts: { all: 1, manual: 1, blocklistedTags: 0 },
  };
  state.titles = {};
  state.keys = [];
  state.revalidate.mockReset();
  state.remove.mockReset();
  state.pinValues = [];
  state.settings = { enabledMediaCategories: { manga: true } };
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <Blocklist />
      </IntlProvider>
    )
  );
};

const detailValue = (label: string) =>
  [...host.querySelectorAll('dt')].find(
    (term) => term.textContent === `${label}:`
  )?.nextElementSibling?.textContent;

const mediaFilterLabels = () =>
  [...host.querySelectorAll('[data-testid="media-filters"] button')].map(
    (button) => button.textContent
  );

it('renders a manga row from its AniList details', async () => {
  state.titles['/api/v1/manga/30013'] = { data: mangaDetails() };
  await render();

  const titleLink = host.querySelector('a.detail-summary-title');
  expect(titleLink?.textContent).toBe('Sample Manga (1994)');
  expect(titleLink?.getAttribute('href')).toBe('/manga/30013');
  expect(detailValue('Media & Format')).toBe('Manga');
  expect(detailValue('First Published')).toBe('1994-07-22');
  expect(detailValue('Chapters')).toBe('120');
  expect(detailValue('Author')).toBe('Story Writer');
  expect(detailValue('Artist')).toBe('Art Illustrator');
  expect(detailValue('Genres')).toBe('Adventure, Drama');
  expect(host.querySelector('dd a[href*="genre"]')).toBeNull();
  expect(
    [...host.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  ).toContain('/imageproxy/anilist/file/cover.jpg');
});

it('keeps a manga row usable from its stored title when details are unavailable', async () => {
  state.titles['/api/v1/manga/30013'] = {
    error: { response: { status: 404 } },
  };
  state.remove.mockResolvedValue({ status: 204 });
  await render();

  const titleLink = host.querySelector('a.detail-summary-title');
  expect(titleLink?.textContent).toBe('Stored Manga Title');
  expect(titleLink?.getAttribute('href')).toBe('/manga/30013');
  expect(detailValue('Media & Format')).toBe('Manga');

  const removeButton = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Remove from Blocklist'
  );
  await act(async () => {
    removeButton!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });

  expect(state.remove).toHaveBeenCalledWith(
    '/api/v1/blocklist/30013?mediaType=manga'
  );
  expect(state.revalidate).toHaveBeenCalled();
});

it('offers the manga media filter only while manga is enabled', async () => {
  state.titles['/api/v1/manga/30013'] = { data: mangaDetails() };
  await render();

  expect(mediaFilterLabels()).toContain('Manga');
  expect(state.pinValues.at(-1)).toContain('manga');

  state.settings = { enabledMediaCategories: { manga: false } };
  await render();

  expect(mediaFilterLabels()).not.toContain('Manga');
  expect(state.pinValues.at(-1)).not.toContain('manga');

  state.settings = {};
  await render();

  expect(mediaFilterLabels()).not.toContain('Manga');
});

it('requests manga rows when the manga filter is chosen', async () => {
  await render();

  const mangaFilter = [
    ...host.querySelectorAll('[data-testid="media-filters"] button'),
  ].find((button) => button.textContent === 'Manga');
  await act(async () => {
    mangaFilter!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });

  expect(mangaFilter?.getAttribute('aria-pressed')).toBe('true');
  expect(
    state.keys.filter((key) => key?.startsWith('/api/v1/blocklist/')).at(-1)
  ).toContain('&mediaType=manga&');
});
