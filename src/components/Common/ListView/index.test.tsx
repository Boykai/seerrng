import { MediaStatus } from '@server/constants/media';
import type { ComicResult } from '@server/models/Comic';
import type { MangaResult } from '@server/models/Manga';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import ListView from '.';

vi.mock('@app/components/TitleCard', () => {
  const TitleCard = ({
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
  );
  TitleCard.Placeholder = () => null;
  return { default: TitleCard };
});
vi.mock('@app/components/ArtistCard', () => ({ default: () => null }));
vi.mock('@app/components/AuthorCard', () => ({ default: () => null }));
vi.mock('@app/components/PersonCard', () => ({ default: () => null }));
vi.mock('@app/components/TitleCard/LibraryTitleCard', () => ({
  default: () => null,
}));
vi.mock('@app/components/TitleCard/TmdbTitleCard', () => ({
  default: () => null,
}));
vi.mock('@app/hooks/useCardTextVisibility', () => ({
  default: () => ({ visibility: {} }),
}));
vi.mock('@app/hooks/useVerticalScroll', () => ({ default: () => undefined }));
vi.mock('@app/hooks/useWarmImageCache', () => ({
  default: () => undefined,
  MAIN_MEDIA_POSTER_CACHE_WARM_LIMIT: 24,
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
});

it('renders manga cards with proxied posters beside other media and hides blocklisted manga', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en">
      <ListView
        items={[
          manga(),
          manga({
            id: 2,
            title: 'Hidden Manga',
            mediaInfo: {
              status: MediaStatus.BLOCKLISTED,
            } as MangaResult['mediaInfo'],
          }),
          manga({ id: 3, title: 'Other Host', posterPath: 'https://x/a.jpg' }),
          {
            id: '4',
            provider: 'comicvine',
            mediaType: 'comic',
            title: 'Sample Comic',
          } as ComicResult,
        ]}
        onScrollBottom={vi.fn()}
      />
    </IntlProvider>
  );

  expect(html).toContain(
    'data-card="manga:30013" data-image="/imageproxy/anilist/file/cover.jpg" data-year="1994"'
  );
  expect(html).toContain('data-card="manga:3" data-image=""');
  expect(html).toContain('data-card="comic:4"');
  expect(html).not.toContain('Hidden Manga');
});
