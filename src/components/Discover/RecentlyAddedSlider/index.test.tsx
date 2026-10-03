import RecentlyAddedSlider, {
  getRecentlyAddedUrl,
} from '@app/components/Discover/RecentlyAddedSlider';
import type * as UseUser from '@app/hooks/useUser';
import { MediaStatus } from '@server/constants/media';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  snapshot: {} as { data?: unknown; error?: unknown; isLoading: boolean },
  snapshotUrls: [] as string[],
  summaries: new Map<string, { data?: unknown }>(),
  summaryKeys: [] as unknown[],
  settings: {} as Record<string, unknown>,
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.summaryKeys.push(key);
    const response = key ? state.summaries.get(key) : undefined;
    return {
      data: response?.data,
      error: undefined,
      isLoading: Boolean(key) && !response,
    };
  },
}));
vi.mock('@app/hooks/useDiscoverRowSnapshot', () => ({
  default: ({ url }: { url: string }) => {
    state.snapshotUrls.push(url);
    return state.snapshot;
  },
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', async (importOriginal) => ({
  ...(await importOriginal<typeof UseUser>()),
  useUser: () => ({ hasPermission: () => true }),
}));
vi.mock('@app/hooks/useWarmImageCache', () => ({
  default: () => undefined,
  MAIN_MEDIA_POSTER_CACHE_WARM_LIMIT: 100,
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => undefined, inView: true }),
}));
vi.mock('@app/components/Slider', () => ({
  default: ({
    items,
    isLoading,
    isEmpty,
  }: {
    items: React.ReactNode[];
    isLoading: boolean;
    isEmpty: boolean;
  }) => (
    <div
      data-testid="slider"
      data-loading={String(isLoading)}
      data-empty={String(isEmpty)}
    >
      {items}
    </div>
  ),
}));
vi.mock('@app/components/TitleCard', () => ({
  default: (props: {
    id: number;
    image?: string;
    status?: number;
    title: string;
    year?: string;
    mediaType: string;
  }) => (
    <div
      data-card={props.mediaType}
      data-id={props.id}
      data-image={props.image}
      data-status={props.status}
      data-year={props.year}
    >
      {props.title}
    </div>
  ),
}));
vi.mock('@app/components/TitleCard/TmdbTitleCard', () => ({
  default: ({ tmdbId, type }: { tmdbId: number; type: string }) => (
    <div data-card={type} data-id={tmdbId} />
  ),
}));

const DEFAULT_URL =
  '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=movie%2Ctv';

const results = [
  { id: 1, mediaType: 'movie', tmdbId: 501, status: MediaStatus.AVAILABLE },
  {
    id: 2,
    mediaType: 'manga',
    anilistId: 30,
    status: MediaStatus.PARTIALLY_AVAILABLE,
  },
  { id: 3, mediaType: 'tv', tmdbId: 503, status: MediaStatus.AVAILABLE },
  // Hidden by the Manga Content settings: the catalog omits it.
  { id: 4, mediaType: 'manga', anilistId: 31, status: MediaStatus.AVAILABLE },
];

let dom: JSDOM;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.snapshot = { data: { results }, isLoading: false };
  state.snapshotUrls = [];
  state.summaries.clear();
  state.summaryKeys = [];
  state.settings = { enabledMediaCategories: { manga: true } };
  state.summaries.set('/api/v1/manga?ids=30%2C31', {
    data: {
      results: [
        {
          id: 30,
          mediaType: 'manga',
          title: 'Catalog Title 30',
          startYear: 2001,
          posterPath: 'https://s4.anilist.co/file/cover/30.jpg',
        },
      ],
    },
  });
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
        <RecentlyAddedSlider />
      </IntlProvider>
    )
  );
};

const cards = () =>
  [...host.querySelectorAll('[data-card]')].map(
    (card) =>
      `${card.getAttribute('data-card')}:${card.getAttribute('data-id')}`
  );
const slider = () => host.querySelector('[data-testid="slider"]')!;

describe('getRecentlyAddedUrl', () => {
  it('keeps the movie and series list while manga is off', () => {
    expect(getRecentlyAddedUrl({})).toBe(DEFAULT_URL);
    expect(
      getRecentlyAddedUrl({
        enabledMediaCategories: { manga: false, movie: false },
      })
    ).toBe(DEFAULT_URL);
  });

  it('asks for manga and only the enabled categories while manga is on', () => {
    expect(
      getRecentlyAddedUrl({ enabledMediaCategories: { manga: true } })
    ).toBe(
      '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=movie%2Ctv%2Cmanga'
    );
    expect(
      getRecentlyAddedUrl({
        enabledMediaCategories: { manga: true, movie: false },
      })
    ).toBe(
      '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=tv%2Cmanga'
    );
    expect(
      getRecentlyAddedUrl({
        enabledMediaCategories: { manga: true, movie: false, tv: false },
      })
    ).toBe(
      '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=manga'
    );
  });
});

describe('RecentlyAddedSlider', () => {
  it('shows movies and series only while manga is off', async () => {
    state.settings = { enabledMediaCategories: { manga: false } };
    await render();

    expect(state.snapshotUrls.at(-1)).toBe(DEFAULT_URL);
    expect(cards()).toEqual(['movie:501', 'tv:503']);
    expect(state.summaryKeys.filter(Boolean)).toEqual([]);
  });

  it('adds manga cards from one catalog read and skips hidden titles', async () => {
    await render();

    expect(state.snapshotUrls.at(-1)).toBe(
      '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded&mediaType=movie%2Ctv%2Cmanga'
    );
    expect(new Set(state.summaryKeys.filter(Boolean))).toEqual(
      new Set(['/api/v1/manga?ids=30%2C31'])
    );
    expect(cards()).toEqual(['movie:501', 'manga:30', 'tv:503']);

    const manga = host.querySelector('[data-card="manga"]')!;
    expect(manga.textContent).toBe('Catalog Title 30');
    expect(manga.getAttribute('data-status')).toBe(
      String(MediaStatus.PARTIALLY_AVAILABLE)
    );
    expect(manga.getAttribute('data-year')).toBe('2001');
    expect(manga.getAttribute('data-image')).toBe(
      '/imageproxy/anilist/file/cover/30.jpg'
    );
    expect(slider().getAttribute('data-empty')).toBe('false');
  });

  it('waits for manga titles before calling an all-manga row empty', async () => {
    state.snapshot = {
      data: { results: results.filter((item) => item.mediaType === 'manga') },
      isLoading: false,
    };
    state.summaries.clear();
    await render();

    expect(slider().getAttribute('data-loading')).toBe('true');
    expect(slider().getAttribute('data-empty')).toBe('false');
    expect(cards()).toEqual([]);
  });

  it('calls the row empty when every manga title is hidden', async () => {
    state.snapshot = {
      data: { results: [results[3]] },
      isLoading: false,
    };
    state.summaries.set('/api/v1/manga?ids=31', { data: { results: [] } });
    await render();

    expect(slider().getAttribute('data-loading')).toBe('false');
    expect(slider().getAttribute('data-empty')).toBe('true');
  });
});
