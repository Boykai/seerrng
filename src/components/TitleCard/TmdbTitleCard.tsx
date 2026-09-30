import TitleCard from '@app/components/TitleCard';
import { Permission, useUser } from '@app/hooks/useUser';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'tv';
  title?: string;
  canExpand?: boolean;
  isAddedToWatchlist?: boolean;
  mutateParent?: () => void;
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const TmdbTitleCard = ({
  id,
  tmdbId,
  tvdbId,
  type,
  title: fallbackTitle,
  canExpand,
  isAddedToWatchlist = false,
  mutateParent,
}: TmdbTitleCardProps) => {
  const { hasPermission } = useUser();

  const { ref, inView } = useInView({
    rootMargin: '100% 0px',
    triggerOnce: true,
  });
  const url = useMemo(
    () =>
      type === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`,
    [tmdbId, type]
  );
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView ? url : null,
    {
      dedupingInterval: 30000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );

  if (!title && !error && fallbackTitle) {
    return (
      <div ref={ref}>
        <TitleCard
          id={id}
          title={fallbackTitle}
          mediaType={type}
          isAddedToWatchlist={isAddedToWatchlist}
          canExpand={canExpand}
          mutateParent={mutateParent}
        />
      </div>
    );
  }

  if (!title && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }

  if (!title) {
    return hasPermission(Permission.ADMIN) ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={tmdbId}
        tvdbId={tvdbId}
        type={type}
      />
    ) : null;
  }

  return isMovie(title) ? (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      status4k={title.mediaInfo?.status4k}
      summary={title.overview}
      title={title.title}
      userScore={title.voteAverage}
      voteCount={title.voteCount}
      year={title.releaseDate}
      mediaType={'movie'}
      inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
      inProgress4k={(title.mediaInfo?.downloadStatus4k ?? []).length > 0}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  ) : (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      status4k={title.mediaInfo?.status4k}
      summary={title.overview}
      title={title.name}
      userScore={title.voteAverage}
      voteCount={title.voteCount}
      year={title.firstAirDate}
      mediaType={'tv'}
      inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
      inProgress4k={(title.mediaInfo?.downloadStatus4k ?? []).length > 0}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  );
};

export default TmdbTitleCard;
