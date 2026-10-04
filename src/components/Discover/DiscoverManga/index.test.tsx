import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DiscoverManga from '.';

const state = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  update: vi.fn(),
  discoverCalls: [] as unknown[][],
  restoration: [] as unknown[],
  discover: {} as Record<string, unknown>,
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
  useSearchActivityReporter: () => undefined,
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
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
  state.discoverCalls = [];
  state.restoration = [];
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
      <IntlProvider locale="en">
        <DiscoverManga />
      </IntlProvider>
    )
  );
};

const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  );

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
});

it('shows a sorted grid and requests the selected sort', async () => {
  state.query = { sortBy: 'top_rated' };
  state.discover = { ...state.discover, titles: [{ id: 1 }, { id: 2 }] };
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
});

it('searches by keyword and ignores unknown sort values', async () => {
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
});

it('updates the route when a sort or the reset is chosen', async () => {
  state.query = { query: 'one piece' };
  await render();

  await act(async () => {
    button('Popular')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  expect(state.update).toHaveBeenLastCalledWith({
    sortBy: 'popular',
    page: undefined,
  });

  await act(async () => {
    button('Clear Filters')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  expect(state.update).toHaveBeenLastCalledWith({
    query: undefined,
    sortBy: undefined,
    page: undefined,
  });
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
