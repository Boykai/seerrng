import { MediaStatus } from '@server/constants/media';
import type { MangaResult } from '@server/models/Manga';
import type { MovieResult } from '@server/models/Search';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import MediaSlider from '.';

const state = vi.hoisted(() => ({
  pages: [] as unknown[],
  keys: [] as unknown[],
}));
vi.mock('swr/infinite', () => ({
  default: (getKey: (index: number, previous: null) => unknown) => {
    state.keys.push(getKey(0, null));
    return {
      data: state.pages,
      error: undefined,
      setSize: vi.fn(),
      size: 1,
      mutate: vi.fn(),
    };
  },
}));
vi.mock('@app/components/TitleCard', () => ({
  default: ({
    id,
    image,
    mediaType,
    title,
    year,
  }: {
    id: number;
    image?: string;
    mediaType: string;
    title: string;
    year?: string;
  }) => (
    <div
      data-card={`${mediaType}:${id}`}
      data-image={image ?? ''}
      data-year={year ?? ''}
    >
      {title}
    </div>
  ),
}));
vi.mock('@app/components/PersonCard', () => ({ default: () => null }));
vi.mock('@app/components/MediaSlider/ShowMoreCard', () => ({
  default: ({ posters }: { posters: (string | undefined)[] }) => (
    <div data-show-more={posters.join(',')} />
  ),
}));
vi.mock('@app/components/Slider', () => ({
  default: ({ items }: { items: React.ReactNode[] }) => <div>{items}</div>,
}));
vi.mock('@app/components/Common/CardTextVisibilityToggle', () => ({
  default: () => null,
}));
vi.mock('@app/hooks/useCardTextVisibility', () => ({
  default: () => ({ visibility: {} }),
}));
vi.mock('@app/hooks/useDiscoverHomeManifest', () => ({
  default: () => ({ manifest: undefined }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: {} }),
}));
vi.mock('@app/hooks/useUser', () => ({
  useUser: () => ({ user: { id: 1, permissions: 2, settings: {} } }),
}));
vi.mock('@app/hooks/useWarmImageCache', () => ({
  default: () => undefined,
  DISCOVER_SHELF_POSTER_CACHE_WARM_LIMIT: 8,
}));
vi.mock('@app/utils/discoverSnapshot', () => ({
  buildDiscoverCacheContextKey: () => 'context',
  buildDiscoverSnapshotKey: () => 'snapshot',
  createDiscoverSnapshot: vi.fn(),
  isDiscoverSnapshotFresh: () => true,
  setDiscoverSnapshot: vi.fn(),
  useDiscoverSnapshot: () => ({ hydrated: true, snapshot: undefined }),
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: vi.fn(), inView: true }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

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
    posterPath: 'https://s4.anilist.co/file/cover.jpg',
    startYear: 1994,
    ...values,
  }) as MangaResult;

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.keys = [];
});

it('renders manga cards in sliders, hides blocklisted manga and requests the sorted page', () => {
  state.pages = [
    {
      page: 1,
      totalPages: 1,
      totalResults: 3,
      results: [
        manga(),
        manga({
          id: 2,
          title: 'Hidden Manga',
          mediaInfo: {
            status: MediaStatus.BLOCKLISTED,
          } as MangaResult['mediaInfo'],
        }),
        {
          id: 5,
          mediaType: 'movie',
          title: 'Sample Movie',
        } as MovieResult,
      ],
    },
  ];

  const html = renderToStaticMarkup(
    <MediaSlider
      title="Trending Manga"
      url="/api/v1/discover/manga"
      extraParams="sortBy=trending"
      linkUrl="/discover/manga?sortBy=trending"
      sliderKey="manga-trending"
    />
  );

  expect(html).toContain(
    'data-card="manga:30013" data-image="/imageproxy/anilist/file/cover.jpg" data-year="1994"'
  );
  expect(html).toContain('data-card="movie:5"');
  expect(html).not.toContain('Hidden Manga');
  expect(state.keys[0]).toEqual([
    '/api/v1/discover/manga?page=1&sortBy=trending',
    'context',
  ]);
});
