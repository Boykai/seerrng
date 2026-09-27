import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import defineMessages from '@app/utils/defineMessages';
import {
  getTmdbPosterImageUrl,
  getTmdbPosterImageVariants,
} from '@app/utils/imageCache';
import type { Collection } from '@server/models/Collection';
import type { CuratedCollection } from '@server/models/CuratedCollection';
import type { MovieDetails } from '@server/models/Movie';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import CollectionOverview from './CollectionOverview';
import CuratedGenreLinks from './CuratedGenreLinks';

const messages = defineMessages('components.CollectionSummaryCard', {
  genres: 'Genres',
  collectionSize: 'Collection Size',
  selectionSize: 'Selection Size',
  overview: 'Overview',
  overviewUnavailable: 'Overview unavailable',
  notAvailable: 'Not Available',
  loading: 'Loading collection details…',
  failed: 'Unable to load collection details.',
  genresFailed: 'Unable to load genre names.',
  retry: 'Retry',
});

const CollectionSummaryCard = ({
  collection,
  kind,
  selectionSize,
}: {
  collection:
    | NonNullable<MovieDetails['collection']>
    | { id: string | number; name: string; posterPath?: string };
  kind?: 'tv' | 'music';
  selectionSize?: { selected: number; visible: number };
}) => {
  const intl = useIntl();
  const { data, error, mutate } = useSWR<Collection | CuratedCollection>(
    kind
      ? `/api/v1/collection-catalog/${kind}/${collection.id}`
      : `/api/v1/collection/${collection.id}`
  );
  const {
    data: genres,
    error: genresError,
    mutate: refreshGenres,
  } = useSWR<{ id: number; name: string }[]>(
    kind ? null : '/api/v1/genres/movie'
  );
  const curated = data && 'kind' in data ? data : undefined;
  const movie = data && !('kind' in data) ? data : undefined;
  const name = data?.name ?? collection.name;
  const posterPath =
    curated?.posterPath ??
    curated?.parts.find((part) => part.posterPath)?.posterPath ??
    movie?.posterPath ??
    collection.posterPath;
  const href = kind
    ? `/collections/${kind}/${collection.id}`
    : `/collection/${collection.id}`;
  const genreIds = [
    ...new Set(movie?.parts.flatMap((part) => part.genreIds ?? []) ?? []),
  ];

  return (
    <section className="app-card-sub detail-item-surface detail-summary-card media-detail-collection-card">
      <div className="collection-summary-header">
        <Link
          href={href}
          aria-label={name}
          className="collection-summary-poster"
        >
          <CachedImage
            type={kind === 'music' ? 'music' : 'tmdb'}
            src={
              (kind === 'music'
                ? posterPath
                : getTmdbPosterImageUrl(posterPath)) ||
              '/images/seerr_poster_not_found.png'
            }
            variants={
              kind === 'music'
                ? undefined
                : getTmdbPosterImageVariants(posterPath)
            }
            alt=""
            fill
            sizes="(min-width: 640px) 80px, 64px"
            className="collection-summary-poster-image"
          />
        </Link>
        <div className="collection-summary-details">
          <h2 className="collection-summary-title">
            <Link href={href}>{name}</Link>
          </h2>
          <dl className="collection-summary-table detail-card-heading-spacing">
            <dt className="collection-summary-overview-label">
              {intl.formatMessage(messages.overview)}:
            </dt>
            <dd className="collection-summary-overview-value">
              {curated?.overview ? (
                <CollectionOverview
                  text={curated.overview}
                  source={curated.overviewSource}
                />
              ) : data ? (
                data.overview ||
                intl.formatMessage(messages.overviewUnavailable)
              ) : (
                '—'
              )}
            </dd>
            <dt className="collection-summary-genres-label">
              {intl.formatMessage(messages.genres)}:
            </dt>
            <dd className="collection-summary-genres-value">
              {curated ? (
                <CuratedGenreLinks
                  kind={curated.kind}
                  parts={curated.parts}
                  fallback={intl.formatMessage(messages.notAvailable)}
                />
              ) : genreIds.length > 0 ? (
                genreIds.map((id, index) => (
                  <span key={id}>
                    {index > 0 && ', '}
                    <Link href={`/discover/movies?genre=${id}`}>
                      {genres?.find((genre) => genre.id === id)?.name ?? id}
                    </Link>
                  </span>
                ))
              ) : data ? (
                intl.formatMessage(messages.notAvailable)
              ) : (
                '—'
              )}
            </dd>
            <div className="collection-summary-size">
              <dt className="collection-summary-size-label">
                {intl.formatMessage(messages.collectionSize)}:
              </dt>
              <dd className="collection-summary-size-value">
                {data?.parts.length ?? '—'}
              </dd>
              {selectionSize && (
                <>
                  <dt className="collection-summary-selection-label">
                    {intl.formatMessage(messages.selectionSize)}:
                  </dt>
                  <dd className="collection-summary-selection-value">
                    {selectionSize.selected} / {selectionSize.visible}
                  </dd>
                </>
              )}
            </div>
          </dl>
        </div>
      </div>
      {(error || genresError || !data) && (
        <div className="collection-summary-status" role="status">
          <span>
            {intl.formatMessage(
              error
                ? messages.failed
                : genresError
                  ? messages.genresFailed
                  : messages.loading
            )}
          </span>
          {(error || genresError) && (
            <Button
              onClick={() => {
                void mutate();
                void refreshGenres();
              }}
            >
              {intl.formatMessage(messages.retry)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
};

export default CollectionSummaryCard;
