import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DiscoverManga from '.';
import { MANGA_FILTER_KEYS } from './mangaFilterParams';

type FilterProps = {
  filters: Record<string, string>;
  onChange: (values: Record<string, string | undefined>) => void;
};

const state = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  update: vi.fn(),
  discoverCalls: [] as unknown[][],
  restoration: [] as unknown[],
  activity: [] as unknown[][],
  filterProps: [] as FilterProps[],
  discover: {} as Record<string, unknown>,
  user: {
    user: {
      id: 7,
      settings: {
        detailDisclosurePins: {
          manga: { filters: true, sortBy: true } as Record<string, boolean>,
        },
      },
    },
    revalidate: vi.fn().mockResolvedValue(undefined),
  },
  post: vi.fn(),
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: state.query }),
}));
vi.mock('@app/hooks/useUpdateQueryParams', () => ({
  useBatchUpdateQueryParams: () => state.update,
}));
vi.mock('@app/hooks/useDiscover', () => ({
  default: (...args: unknown[]) => {
    state.discoverCalls.push(args);
    return state.discover;
  },
}));
vi.mock('@app/hooks/useDiscoverScrollRestoration', () => ({
  default: (options: unknown) => {
    state.restoration.push(options);
  },
}));
vi.mock('@app/hooks/useSearchActivity', () => ({
  default: () => false,
  useSearchActivityReporter: (...args: unknown[]) => {
    state.activity.push(args);
  },
}));
vi.mock('@app/hooks/useUser', () => ({ useUser: () => state.user }));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('./MangaFilters', () => ({
  default: (props: FilterProps) => {
    state.filterProps.push(props);
    return <div data-testid="manga-filters" />;
  },
}));
vi.mock('@app/components/MediaSlider', () => ({
  default: ({
    sliderKey,
    title,
    url,
    extraParams,
    linkUrl,
  }: {
    sliderKey: string;
    title: string;
    url: string;
    extraParams: string;
    linkUrl: string;
  }) => (
    <section
      data-slider={sliderKey}
      data-url={url}
      data-params={extraParams}
      data-link={linkUrl}
    >
      {title}
    </section>
  ),
}));
vi.mock('@app/components/Common/ListView', () => ({
  default: ({ items }: { items: { id: number }[] }) => (
    <div data-testid="list">{items.map((item) => item.id).join(',')}</div>
  ),
}));

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
  state.query = {};
  state.update.mockReset();
  state.post.mockReset();
  state.discoverCalls = [];
  state.restoration = [];
  state.activity = [];
  state.filterProps = [];
  state.user.user.settings.detailDisclosurePins.manga = {
    filters: true,
    sortBy: true,
  };
  state.discover = {
    titles: [],
    isEmpty: false,
    isLoadingInitialData: false,
    isLoadingMore: false,
    isValidating: false,
    isReachingEnd: true,
    fetchMore: vi.fn(),
    error: undefined,
    shuffleSeed: 'seed',
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          revalidateOnMount: false,
          revalidateOnFocus: false,
        }}
      >
        <IntlProvider locale="en">
          <DiscoverManga />
        </IntlProvider>
      </SWRConfig>
    )
  );
};

const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  );
const click = async (element: Element | undefined) => {
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
};

it('shows one shelf per sort order on the landing page', async () => {
  await render();

  expect(
    [...host.querySelectorAll('[data-slider]')].map((slider) => ({
      key: slider.getAttribute('data-slider'),
      url: slider.getAttribute('data-url'),
      params: slider.getAttribute('data-params'),
      link: slider.getAttribute('data-link'),
      title: slider.textContent,
    }))
  ).toEqual([
    {
      key: 'manga-trending',
      url: '/api/v1/discover/manga',
      params: 'sortBy=trending',
      link: '/discover/manga?sortBy=trending',
      title: 'Trending Manga',
    },
    {
      key: 'manga-popular',
      url: '/api/v1/discover/manga',
      params: 'sortBy=popular',
      link: '/discover/manga?sortBy=popular',
      title: 'Popular Manga',
    },
    {
      key: 'manga-top_rated',
      url: '/api/v1/discover/manga',
      params: 'sortBy=top_rated',
      link: '/discover/manga?sortBy=top_rated',
      title: 'Top Rated Manga',
    },
  ]);
  expect(host.querySelector('[data-testid="list"]')).toBeNull();
  expect(state.discoverCalls.at(-1)?.[2]).toMatchObject({ enabled: false });
  expect(button('Clear Filters')?.getAttribute('aria-pressed')).toBe('true');
  expect(
    [...host.querySelectorAll('button[aria-pressed="true"]')].map(
      (pressed) => pressed.textContent
    )
  ).not.toContain('Trending');
  expect(state.activity.at(-1)).toEqual([false, 'manga-discovery']);
});

it('shows a sorted grid and requests the selected sort', async () => {
  state.query = { sortBy: 'top_rated' };
  state.discover = {
    ...state.discover,
    titles: [{ id: 1 }, { id: 2 }],
    isValidating: true,
  };
  await render();

  expect(host.querySelector('[data-slider]')).toBeNull();
  expect(host.querySelector('[data-testid="list"]')?.textContent).toBe('1,2');
  expect(state.discoverCalls.at(-1)).toEqual([
    '/api/v1/discover/manga',
    { query: '', sortBy: 'top_rated' },
    { enabled: true, showErrorToast: false, hideErrorWithResults: false },
  ]);
  expect(state.restoration.at(-1)).toMatchObject({
    mediaType: 'manga',
    itemCount: 2,
  });
  expect(button('Top Rated')?.getAttribute('aria-pressed')).toBe('true');
  expect(button('Trending')?.getAttribute('aria-pressed')).toBe('false');
  expect(state.activity.at(-1)).toEqual([true, 'manga-discovery']);
});

it('searches by keyword by relevance and ignores unknown sort values', async () => {
  state.query = { query: ' one piece ', sortBy: 'newest' };
  await render();

  expect(state.discoverCalls.at(-1)?.[1]).toEqual({
    query: 'one piece',
    sortBy: undefined,
  });
  expect(
    host.querySelector('input[type="search"]')?.getAttribute('value')
  ).toBe('one piece');
  expect(button('Clear Filters')?.getAttribute('aria-pressed')).toBe('false');
  expect(button('Trending')?.getAttribute('aria-pressed')).toBe('false');
});

it('requests the address filters and marks Trending as the default order', async () => {
  state.query = {
    genres: 'Action, Drama,Action',
    minScore: '70',
    format: 'BOOK',
    maxChapters: '-1',
  };
  await render();

  expect(host.querySelector('[data-slider]')).toBeNull();
  expect(host.querySelector('[data-testid="list"]')).not.toBeNull();
  expect(state.discoverCalls.at(-1)).toEqual([
    '/api/v1/discover/manga',
    { query: '', sortBy: undefined, genres: 'Action,Drama', minScore: '70' },
    { enabled: true, showErrorToast: false, hideErrorWithResults: false },
  ]);
  expect(state.filterProps.at(-1)?.filters).toEqual({
    genres: 'Action,Drama',
    minScore: '70',
  });
  expect(button('Trending')?.getAttribute('aria-pressed')).toBe('true');
  expect(button('Clear Filters')?.getAttribute('aria-pressed')).toBe('false');
});

it('starts each sort descending and reverses the active one', async () => {
  state.query = { sortBy: 'start_date.desc' };
  await render();

  expect(button('Start Date')?.getAttribute('aria-pressed')).toBe('true');
  await click(button('Start Date'));
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'start_date.asc',
    page: undefined,
  });
  await click(button('Title'));
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'title.desc',
    page: undefined,
  });

  state.query = { sortBy: 'start_date.asc' };
  await render();
  expect(button('Start Date')?.getAttribute('aria-pressed')).toBe('true');
  await click(button('Start Date'));
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'start_date.desc',
    page: undefined,
  });

  state.query = { sortBy: 'trending' };
  await render();
  await click(button('Trending'));
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'trending',
    page: undefined,
  });
});

it('updates the route when a filter, a sort or the reset is chosen', async () => {
  state.query = { query: 'one piece', genres: 'Action' };
  await render();

  await act(async () =>
    state.filterProps.at(-1)!.onChange({
      excludeGenres: 'Action',
      genres: undefined,
    })
  );
  expect(state.update).toHaveBeenLastCalledWith({
    excludeGenres: 'Action',
    genres: undefined,
    page: undefined,
  });

  await click(button('Popular'));
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'popular',
    page: undefined,
  });

  await click(button('Clear Filters'));
  const reset = state.update.mock.lastCall![0];
  expect(Object.keys(reset).sort()).toEqual(
    [...MANGA_FILTER_KEYS, 'page', 'query', 'sortBy'].sort()
  );
  expect(Object.values(reset).every((value) => value === undefined)).toBe(true);
});

it('mounts the filter controls only while the Filters section is open', async () => {
  state.user.user.settings.detailDisclosurePins.manga = {
    filters: false,
    sortBy: false,
  };
  state.post.mockImplementation(
    async (_endpoint: string, patch: Record<string, boolean>) => ({
      data: { filters: false, sortBy: false, ...patch },
    })
  );
  await render();

  expect(state.filterProps).toHaveLength(0);
  expect(button('Clear Filters')).toBeUndefined();

  await click(
    host.querySelector('section[aria-label="Filters"] [aria-expanded]')!
  );
  expect(state.filterProps.length).toBeGreaterThan(0);
  expect(button('Clear Filters')).toBeDefined();

  await click(
    host.querySelector('section[aria-label="Sort By"] [aria-pressed]')!
  );
  expect(state.post).toHaveBeenCalledWith(
    '/api/v1/user/7/settings/detail-disclosures/manga',
    { sortBy: true }
  );
});

it('shows the provider message when discovery fails', async () => {
  state.query = { sortBy: 'trending' };
  state.discover = {
    ...state.discover,
    error: { response: { data: { message: 'AniList is unavailable.' } } },
  };
  await render();

  expect(host.textContent).toContain('AniList is unavailable.');
  expect(host.querySelector('[data-testid="list"]')).toBeNull();
});
