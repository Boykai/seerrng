import type { MovieDetails } from '@server/models/Movie';
import { expect, it } from 'vitest';
import { getMovieTrailerUrl } from './movieTrailer';
const videos = [
  { type: 'Teaser', size: 2160, url: 'https://example.com/teaser' },
  { type: 'Trailer', size: 720, url: 'https://example.com/trailer' },
  {
    type: 'Trailer',
    size: 1080,
    site: 'YouTube',
    key: 'first-movie',
    url: 'https://youtube.com/watch?v=first-movie',
  },
] as NonNullable<MovieDetails['relatedVideos']>;
it('uses the highest-resolution trailer and honors the configured YouTube host', () => {
  expect(getMovieTrailerUrl(videos, 'https://video.example/watch?v=')).toBe(
    'https://video.example/watch?v=first-movie'
  );
  expect(videos[0].type).toBe('Teaser');
});
it('keeps the original video URL when no alternate host is set', () => {
  expect(getMovieTrailerUrl(videos)).toBe(
    'https://youtube.com/watch?v=first-movie'
  );
});
it('does not produce a trailer link for missing trailers or unsafe URLs', () => {
  expect(getMovieTrailerUrl()).toBeUndefined();
  expect(
    getMovieTrailerUrl([
      { type: 'Trailer', size: 1080, url: 'javascript:alert(1)' },
    ] as MovieDetails['relatedVideos'])
  ).toBeFalsy();
});
