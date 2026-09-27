import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import CuratedGenreLinks from './CuratedGenreLinks';

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
beforeEach(() => vi.stubGlobal('React', React));

it('uses stable TV genre IDs regardless of the displayed language and deduplicates', () => {
  const html = renderToStaticMarkup(
    <CuratedGenreLinks
      kind="tv"
      parts={[
        { genres: ['Drame', 'Western'], genreIds: [18, 37] },
        { genres: ['Drame'], genreIds: [18] },
      ]}
    />
  );
  expect(html).toContain('href="/discover/tv?genre=18">Drame</a>');
  expect(html).toContain('href="/discover/tv?genre=37">Western</a>');
  expect(html.match(/genre=18/g)).toHaveLength(1);
});
it('encodes music tag names in the existing discovery filter', () => {
  const html = renderToStaticMarkup(
    <CuratedGenreLinks kind="music" parts={[{ genres: ['rock & roll'] }]} />
  );
  expect(html).toContain('href="/discover/music?genre=rock%20%26%20roll"');
});
it('keeps unmapped TV labels readable without inventing a link', () => {
  const html = renderToStaticMarkup(
    <CuratedGenreLinks kind="tv" parts={[{ genres: ['Unknown'] }]} />
  );
  expect(html).toContain('Unknown');
  expect(html).not.toContain('href');
});
it('renders the caller fallback for an empty genre list', () => {
  expect(
    renderToStaticMarkup(
      <CuratedGenreLinks kind="music" parts={[]} fallback="Not Available" />
    )
  ).toBe('Not Available');
});

it('ranks music genres by album frequency, merges case and limits to six links', () => {
  const html = renderToStaticMarkup(
    <CuratedGenreLinks
      kind="music"
      parts={[
        {
          genres: [
            'Jazz',
            'pop',
            'Pop',
            'rock',
            'dance',
            'soul',
            'house',
            'folk',
            'blues',
          ],
        },
        { genres: ['pop', 'rock'] },
        { genres: ['rock'] },
      ]}
    />
  );
  expect(html.match(/<a /g)).toHaveLength(6);
  expect(html.indexOf('>rock</a>')).toBeLessThan(html.indexOf('>pop</a>'));
  expect(html.match(/genre=pop/g)).toHaveLength(1);
});
