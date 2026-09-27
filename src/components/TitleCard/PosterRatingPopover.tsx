import CollectionRatings from '@app/components/CollectionDetails/CollectionRatings';
import MusicRatings from '@app/components/MediaDetails/MusicRatings';
import OpenLibraryRating from '@app/components/MediaDetails/OpenLibraryRating';
import { getCollectionMemberRatings } from '@app/utils/collectionRatings';
import type { OpenLibraryWorkRatingResponse } from '@server/api/openlibrary';
import type { RTRating } from '@server/api/rating/rottentomatoes';
import type { RatingResponse } from '@server/api/ratings';
import type { MusicRatingResponse } from '@server/models/Music';
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';

type RatedMediaType = 'movie' | 'tv' | 'album' | 'book';

export default function PosterRatingPopover({
  anchorRef,
  id,
  mediaType,
  userScore,
  voteCount,
  bookRatingAverage,
  bookRatingCount,
  title,
  artist,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  id: string | number;
  mediaType: RatedMediaType;
  userScore?: number;
  voteCount?: number;
  bookRatingAverage?: number;
  bookRatingCount?: number;
  title: string;
  artist?: string;
}) {
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
  }>();
  const updatePosition = useCallback(() => {
    const card = anchorRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - width - 8)
    );
    const top =
      rect.bottom + 8 + 96 <= window.innerHeight
        ? rect.bottom + 8
        : Math.max(8, rect.top - 96);
    setPosition({ top, left, width });
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  const { data: movieRatings, isValidating: movieLoading } =
    useSWR<RatingResponse>(
      mediaType === 'movie' ? '/api/v1/movie/' + id + '/ratingscombined' : null,
      { revalidateOnFocus: false }
    );
  const { data: tvRating, isValidating: tvLoading } = useSWR<RTRating>(
    mediaType === 'tv' ? '/api/v1/tv/' + id + '/ratings' : null,
    { revalidateOnFocus: false }
  );
  const { data: musicRatings, isValidating: musicLoading } =
    useSWR<MusicRatingResponse>(
      mediaType === 'album'
        ? '/api/v1/music/' + encodeURIComponent(id) + '/rating'
        : null,
      { revalidateOnFocus: false }
    );
  const hasBookRating = bookRatingAverage !== undefined && !!bookRatingCount;
  const { data: bookRating, isValidating: bookLoading } =
    useSWR<OpenLibraryWorkRatingResponse>(
      mediaType === 'book' && !hasBookRating
        ? '/api/v1/book/' + encodeURIComponent(id) + '/ratings'
        : null,
      { revalidateOnFocus: false }
    );

  if (!position || typeof document === 'undefined') return null;
  const videoRatings =
    mediaType === 'movie' || mediaType === 'tv'
      ? getCollectionMemberRatings(
          {
            id: Number(id),
            voteAverage: userScore ?? 0,
            voteCount: voteCount ?? 0,
          },
          mediaType === 'movie' ? movieRatings : { rt: tvRating }
        )
          .map((rating) =>
            rating.source === 'tmdb' && mediaType === 'tv'
              ? { ...rating, href: 'https://www.themoviedb.org/tv/' + id }
              : rating
          )
          .filter((rating) => rating.value !== undefined)
      : [];
  const albumRatings =
    musicRatings?.ratings ??
    (musicRatings?.rating ? [musicRatings.rating] : []);
  const bookAverage = hasBookRating ? bookRatingAverage : bookRating?.average;
  const bookCount = hasBookRating ? bookRatingCount : bookRating?.count;
  const loading =
    (mediaType === 'movie' && movieLoading) ||
    (mediaType === 'tv' && tvLoading) ||
    (mediaType === 'album' && musicLoading) ||
    (mediaType === 'book' && bookLoading);
  const hasRatings =
    videoRatings.length > 0 ||
    albumRatings.length > 0 ||
    (bookAverage !== undefined && !!bookCount);

  return createPortal(
    <div
      className="poster-rating-popover app-card-main refreshed-card-surface"
      style={position}
      role="status"
      aria-label={'Ratings for ' + title}
    >
      <div className="poster-rating-title">Ratings</div>
      <div className="poster-rating-values">
        {videoRatings.length > 0 && (
          <CollectionRatings ratings={videoRatings} />
        )}
        {albumRatings.length > 0 && (
          <MusicRatings
            ratings={albumRatings}
            albumId={String(id)}
            albumTitle={title}
            artist={artist}
          />
        )}
        {mediaType === 'book' && (
          <OpenLibraryRating
            average={bookAverage}
            count={bookCount}
            workId={String(id)}
            interactive={false}
          />
        )}
        {!hasRatings && (
          <span>{loading ? 'Loading ratings…' : 'No ratings available'}</span>
        )}
      </div>
    </div>,
    document.body
  );
}
