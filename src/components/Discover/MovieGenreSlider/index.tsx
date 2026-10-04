import { genreColorMap } from '@app/components/Discover/constants';
import GenreCard from '@app/components/GenreCard';
import Slider from '@app/components/Slider';
import useDiscoverRowSnapshot from '@app/hooks/useDiscoverRowSnapshot';
import defineMessages from '@app/utils/defineMessages';
import type { GenreSliderItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import React from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';

const MOVIE_GENRES_URL = '/api/v1/discover/genreslider/movie';

const messages = defineMessages('components.Discover.MovieGenreSlider', {
  moviegenres: 'Movie Genres',
});

const MovieGenreSlider = () => {
  const intl = useIntl();
  const { ref, inView } = useInView({
    rootMargin: '450px 0px',
    triggerOnce: true,
  });
  const { data, error, isLoading } = useDiscoverRowSnapshot<GenreSliderItem[]>({
    enabled: inView,
    rowKey: 'movie-genres',
    url: MOVIE_GENRES_URL,
  });

  return (
    <div ref={ref}>
      <Slider
        heading={
          <>
            <Link href="/discover/movies/genres" className="page-heading">
              <span>{intl.formatMessage(messages.moviegenres)}</span>
            </Link>
          </>
        }
        compact
        sliderKey="movie-genres"
        isLoading={isLoading && !error}
        isEmpty={false}
        items={(data ?? []).map((genre, index) => (
          <GenreCard
            key={`genre-${genre.id}-${index}`}
            name={genre.name}
            image={`https://image.tmdb.org/t/p/w780_filter(duotone,${
              genreColorMap[genre.id] ?? genreColorMap[0]
            })${genre.backdrops[4]}`}
            url={`/discover/movies?genre=${genre.id}`}
          />
        ))}
        placeholder={<GenreCard.Placeholder />}
        emptyMessage=""
      />
    </div>
  );
};

export default React.memo(MovieGenreSlider);
