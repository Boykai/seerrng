import type { MovieDetails } from '@server/models/Movie';
import { getSafeHref } from './safeUrl';

export const getMovieTrailerUrl = (
  videos: MovieDetails['relatedVideos'] = [],
  youtubeUrl = ''
) => {
  const trailer = videos
    .filter((video) => video.type === 'Trailer')
    .sort((a, b) => a.size - b.size)
    .pop();
  const url =
    trailer?.site === 'YouTube' && youtubeUrl
      ? `${youtubeUrl}${trailer.key}`
      : trailer?.url;
  return url ? getSafeHref(url) : undefined;
};
