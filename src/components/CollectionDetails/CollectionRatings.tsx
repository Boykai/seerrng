import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import Tooltip from '@app/components/Common/Tooltip';
import type { CollectionRating } from '@app/utils/collectionRatings';
import defineMessages from '@app/utils/defineMessages';
import { getSafeHref } from '@app/utils/safeUrl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.CollectionRatings', {
  critics: 'Rotten Tomatoes critics',
  audience: 'Rotten Tomatoes audience',
  imdb: 'IMDb',
  metacritic: 'Metacritic',
  trakt: 'Trakt',
  tmdb: 'TMDB',
  average:
    '{source}: average of {count} rated titles out of {total}. Missing ratings are excluded.',
  unavailable: '{source}: no rating available.',
  loading: '{source}: loading collection ratings.',
});

const CollectionRatings = ({
  ratings,
  total,
  loading = false,
  unknownValue = '—',
  loadingValue = '…',
  reserveValueSpace = false,
  tooltips,
}: {
  ratings: CollectionRating[];
  total?: number;
  loading?: boolean;
  unknownValue?: string;
  loadingValue?: string;
  reserveValueSpace?: boolean;
  tooltips?: Partial<Record<CollectionRating['source'], string>>;
}) => {
  const intl = useIntl();
  return (
    <>
      {ratings.map((rating) => {
        const source = intl.formatMessage(messages[rating.source]);
        const value = loading && !reserveValueSpace ? undefined : rating.value;
        const pending = loading && value === undefined;
        const tooltip = pending
          ? intl.formatMessage(messages.loading, { source })
          : total !== undefined
            ? intl.formatMessage(messages.average, {
                source,
                count: rating.count,
                total,
              })
            : value === undefined
              ? intl.formatMessage(messages.unavailable, { source })
              : (tooltips?.[rating.source] ?? source);
        const Icon =
          rating.source === 'critics'
            ? value !== undefined && value < 60
              ? RTRotten
              : RTFresh
            : rating.source === 'audience'
              ? value !== undefined && value < 60
                ? RTAudRotten
                : RTAudFresh
              : rating.source === 'imdb'
                ? ImdbLogo
                : rating.source === 'trakt'
                  ? TraktLogo
                  : rating.source === 'tmdb'
                    ? TmdbLogo
                    : undefined;
        const content = (
          <>
            {rating.source === 'metacritic' ? (
              <span
                className="media-rating-brand media-rating-brand-metacritic"
                aria-hidden="true"
              >
                MC
              </span>
            ) : Icon ? (
              <Icon
                aria-hidden="true"
                className={
                  rating.source === 'imdb' ||
                  rating.source === 'tmdb' ||
                  rating.source === 'trakt'
                    ? 'media-rating-wordmark'
                    : 'media-rating-icon'
                }
              />
            ) : null}
            <span className="media-rating-value">
              {pending
                ? loadingValue
                : value === undefined
                  ? unknownValue
                  : rating.source === 'imdb' || rating.source === 'trakt'
                    ? value.toFixed(1)
                    : `${Math.round(value)}%`}
            </span>
          </>
        );
        const href =
          value !== undefined && rating.href
            ? getSafeHref(rating.href)
            : undefined;
        return (
          <Tooltip key={rating.source} content={tooltip}>
            {href ? (
              <a
                className="media-rating-link"
                data-rating-layout={reserveValueSpace ? 'fixed' : undefined}
                aria-label={tooltip}
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                {content}
              </a>
            ) : (
              <span
                className="media-rating-link"
                data-rating-layout={reserveValueSpace ? 'fixed' : undefined}
                aria-label={tooltip}
              >
                {content}
              </span>
            )}
          </Tooltip>
        );
      })}
    </>
  );
};

export default CollectionRatings;
