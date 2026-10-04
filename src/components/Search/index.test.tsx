import type { MangaResult } from '@server/models/Manga';
import type { ComicResult, MovieResult } from '@server/models/Search';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import Search from '.';

const state = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  settings: {} as Record<string, unknown>,
  titles: [] as unknown[],
  discover: [] as { endpoint: string; options: unknown; enabled: boolean }[],
}));
vi.mock('next/router', () => ({
  useRouter: () => ({
    isReady: true,
    query: state.query,
    pathname: '/search',
    asPath: '/search',
    replace: vi.fn(),
  }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useDiscover', () => ({
  default: (
    endpoint: string,
    options: unknown,
    config: { enabled: boolean }
  ) => {
    state.discover.push({ endpoint, options, enabled: config.enabled });
    return {
      isLoadingInitialData: false,
      isEmpty: false,
      isLoadingMore: false,
      isValidating: false,
      isReachingEnd: true,
      titles: state.titles,
      fetchMore: vi.fn(),
      error: undefined,
      mutate: vi.fn(),
    };
  },
}));
vi.mock('@app/hooks/useMediaFilterPin', () => ({ default: () => ({}) }));
vi.mock('@app/hooks/useSearchActivity', () => ({
  default: () => false,
  setSearchActivity: vi.fn(),
}));
vi.mock('@app/components/Common/ListView', () => ({
  default: ({ items }: { items: { mediaType: string; id: number }[] }) => (
    <ul>
      {items.map((item) => (
        <li
          key={`${item.mediaType}:${item.id}`}
          data-item={`${item.mediaType}:${item.id}`}
        />
      ))}
    </ul>
  ),
}));
vi.mock('@app/components/Discover/PinnedFilterSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock('@app/components/Discover/MediaFilterOption', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  FilterResetButton: () => null,
  getFilterToggleButtonClass: () => 'app-filter-button',
}));
vi.mock('@app/components/Discover/constants', () => ({
  prepareFilterValues: (values: Record<string, unknown>) => values,
}));
vi.mock('@app/components/Common/CardTextVisibilityToggle', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@app/components/SoftwareCatalog', () => ({ default: () => null }));
vi.mock('./ContextualSearchFilters', () => ({ default: () => null }));
vi.mock('./SoftwareSearchPreview', () => ({ default: () => null }));

const manga = (values: Partial<MangaResult> = {}): MangaResult =>
  ({
    id: 30013,
    mediaType: 'manga',
    provider: 'anilist',
    title: 'Sample Manga',
    titles: { romaji: 'Sample Manga' },
    synonyms: [],
    isAdult: false,
    genres: [],
    startYear: 1994,
    ...values,
  }) as MangaResult;
const mixedResults = () => [
  { id: 5, mediaType: 'movie', title: 'Sample Movie' } as MovieResult,
  {
    id: '7',
    provider: 'comicvine',
    mediaType: 'comic',
    title: 'Sample Comic',
  } as ComicResult,
  manga(),
  manga({
    id: 41,
    title: 'Another Manga',
    titles: { romaji: 'Betsu', english: 'Another Manga' },
    synonyms: ['Kaibutsu Tales'],
  }),
];

const render = () =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <Search />
    </IntlProvider>
  );
const items = (html: string) =>
  [...html.matchAll(/data-item="([^"]+)"/g)].map(([, item]) => item).sort();
const categoryButtons = (html: string) =>
  [...html.matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)</g)].map(
    ([, label]) => label
  );

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.query = { query: 'monster' };
  state.settings = { enabledMediaCategories: { manga: true } };
  state.titles = mixedResults();
  state.discover = [];
});

it('renders manga beside other media in mixed search results', () => {
  const html = render();

  expect(categoryButtons(html)).toContain('Manga');
  expect(items(html)).toEqual([
    'comic:7',
    'manga:30013',
    'manga:41',
    'movie:5',
  ]);
});

it('narrows the Manga category to manga and matches alternative titles', () => {
  state.query = { query: 'monster', type: 'manga' };
  let html = render();

  expect(state.discover.at(-1)).toEqual({
    endpoint: '/api/v1/search',
    options: { query: 'monster', type: 'manga' },
    enabled: true,
  });
  expect(items(html)).toEqual(['manga:30013', 'manga:41']);

  state.query = { query: 'monster', type: 'manga', resultFilter: 'kaibutsu' };
  html = render();
  expect(items(html)).toEqual(['manga:41']);
});

it('hides the Manga category while manga is off and falls back to all media', () => {
  state.settings = {};
  state.query = { query: 'monster', type: 'manga' };
  const html = render();

  expect(categoryButtons(html)).not.toContain('Manga');
  expect(state.discover.at(-1)?.options).toEqual({ query: 'monster' });
});
