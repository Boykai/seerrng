import type { AssociationEdge } from '@app/hooks/useAssociations';
import type { MovieDetails } from '@server/models/Movie';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import AssociationDetailCard from './AssociationDetailCard';

let details: Partial<MovieDetails> | undefined;
vi.mock('./useAssociationMovieDetails', () => ({
  default: () => ({ ref: { current: null }, data: details }),
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: () => <span role="img" aria-label="Poster" />,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
beforeEach(() => {
  vi.stubGlobal('React', React);
  details = undefined;
});
const render = (node: AssociationEdge['node']) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <AssociationDetailCard
        edge={{ node, reason: 'Shared cast', type: 'shared-person', weight: 1 }}
      />
    </IntlProvider>
  );
it('reuses the movie summary without an extra inset and keeps the association after availability', () => {
  details = {
    id: 1,
    title: 'Example',
    releaseDate: '2020-01-01',
    runtime: 100,
    genres: [{ id: 1, name: 'Comedy' }],
    productionCompanies: [],
    credits: { cast: [], crew: [] },
  };
  const html = render({
    id: 1,
    title: 'Example',
    mediaType: 'movie',
  } as AssociationEdge['node']);
  for (const text of [
    'movie-summary-card',
    'refreshed-card-surface',
    '100 minutes',
    'Director:',
    'Screenplay:',
    'Studio:',
    'Comedy',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('refreshed-inset-surface');
  expect(html.indexOf('detail-summary-footer')).toBeGreaterThan(
    html.indexOf('4K:')
  );
  expect(html.match(/href="\/movie\/1"/g)).toHaveLength(2);
  expect(html).toContain('Shared cast');
});
it('keeps search-result fallback usable when enrichment is unavailable', () => {
  const html = render({
    id: 2,
    title: 'Fallback',
    mediaType: 'movie',
    releaseDate: '2021-01-01',
  } as AssociationEdge['node']);
  expect(html).toContain('Fallback (2021)');
  expect(html).toContain('Not Available');
  expect(html).toContain('Shared cast');
});
it('uses three shared columns for books without misleading video-quality labels', () => {
  const html = render({
    id: 'OL1W',
    title: 'Book',
    mediaType: 'book',
    author: 'Author',
    publisher: 'Publisher',
  });
  expect(html).toContain('detail-three-column-grid');
  expect(html).toContain('collection-summary-poster');
  expect(html).toContain('Author:');
  expect(html).toContain('Publisher:');
  expect(html).not.toContain('HD:');
  expect(html).not.toContain('4K:');
  expect(html).toContain('detail-summary-footer');
});
