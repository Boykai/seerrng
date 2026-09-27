import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
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
}: {
  ratings: CollectionRating[];
  total?: number;
  loading?: boolean;
}) => {
  const intl = useIntl();
  return (
    <>
      {ratings.map((rating) => {
        const source = intl.formatMessage(messages[rating.source]);
        const value = loading ? undefined : rating.value;
        const tooltip = loading
          ? intl.formatMessage(messages.loading, { source })
          : total !== undefined
            ? intl.formatMessage(messages.average, {
                source,
                count: rating.count,
                total,
              })
            : value === undefined
              ? intl.formatMessage(messages.unavailable, { source })
              : source;
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
                : TmdbLogo;
        const content = (
          <>
            <Icon
              aria-hidden="true"
              className={
                rating.source === 'imdb' || rating.source === 'tmdb'
                  ? 'media-rating-wordmark'
                  : 'media-rating-icon'
              }
            />
            <span className="media-rating-value">
              {loading
                ? '…'
                : value === undefined
                  ? '—'
                  : rating.source === 'imdb'
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
                aria-label={tooltip}
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                {content}
              </a>
            ) : (
              <span className="media-rating-link" aria-label={tooltip}>
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
