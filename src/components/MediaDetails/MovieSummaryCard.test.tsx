import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MovieDetails } from '@server/models/Movie';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import MovieSummaryCard from './MovieSummaryCard';
vi.mock('@app/components/Common/CachedImage', () => ({
  default: () => <img alt="" />,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
beforeEach(() => vi.stubGlobal('React', React));
const render = (collection: boolean) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <MovieSummaryCard
        data={{
          id: 1,
          title: 'Fixture movie',
          releaseDate: '2020-01-01',
          runtime: 100,
          genres: [{ id: 1, name: 'Comedy' }],
          productionCompanies: [
            { id: 2, name: 'Fixture studio' },
          ] as MovieDetails['productionCompanies'],
          mediaInfo: {
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          } as Media,
        }}
        sortedCrew={
          [
            {
              id: 3,
              creditId: 'director',
              name: 'Fixture director',
              job: 'Director',
            },
            {
              id: 4,
              creditId: 'writer',
              name: 'Fixture writer',
              job: 'Screenplay',
            },
          ] as MovieDetails['credits']['crew']
        }
        show4kAvailability={true}
        href={collection ? '/movie/1' : undefined}
        ratings={collection ? <span>Four source ratings</span> : undefined}
      />
    </IntlProvider>
  );
it('uses the full movie summary fields and linked title/poster for collection members', () => {
  const html = render(true);
  for (const text of [
    'Media &amp; Format',
    'Release Date',
    '100 minutes',
    'Fixture director',
    'Fixture writer',
    'Fixture studio',
    'Comedy',
    'HD:',
    '4K:',
  ])
    expect(html).toContain(text);
  expect(html.match(/href="\/movie\/1"/g)).toHaveLength(2);
  expect(html.indexOf('movie-summary-ratings-row')).toBeGreaterThan(
    html.indexOf('Comedy')
  );
  expect(html).toContain('Four source ratings');
  expect(html).toContain(
    'class="movie-summary-ratings-empty" aria-hidden="true"'
  );
  expect(html).toContain(
    'class="movie-summary-ratings-values" aria-label="Ratings"'
  );
  expect(html).toContain('detail-item-surface');
  expect(html).toContain('Not Available');
  expect(html).not.toContain('Not available');
});
it('preserves the movie-page heading and inset without adding a duplicate ratings row', () => {
  const html = render(false);
  expect(html).toContain('<h1');
  expect(html).toContain('refreshed-inset-surface');
  expect(html).not.toContain('movie-summary-ratings-row');
});
