import TraktLogo from '@app/assets/services/trakt.svg';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import type { ParsedMdblistRatings } from '@server/api/mdblist';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MdblistRatingBadges', {
  metacritic: 'Metacritic score',
  trakt: 'Trakt score',
});

const MdblistRatingBadges = ({
  ratings,
}: {
  ratings?: ParsedMdblistRatings;
}) => {
  const intl = useIntl();
  const metacritic = ratings?.metacriticRating;
  const trakt = ratings?.traktRating;

  return (
    <>
      {typeof metacritic === 'number' &&
        Number.isFinite(metacritic) &&
        metacritic >= 0 &&
        metacritic <= 100 && (
          <Tooltip content={intl.formatMessage(messages.metacritic)}>
            <span className="media-rating-link media-rating-provider-link">
              <span
                aria-hidden="true"
                className="media-rating-brand media-rating-brand-metacritic"
              >
                MC
              </span>
              <span className="media-rating-value">
                {Math.round(metacritic)}%
              </span>
            </span>
          </Tooltip>
        )}
      {typeof trakt === 'number' &&
        Number.isFinite(trakt) &&
        trakt >= 0 &&
        trakt <= 10 && (
          <Tooltip content={intl.formatMessage(messages.trakt)}>
            <span className="media-rating-link media-rating-provider-link">
              <TraktLogo aria-hidden="true" className="media-rating-wordmark" />
              <span className="media-rating-value">{trakt.toFixed(1)}</span>
            </span>
          </Tooltip>
        )}
    </>
  );
};

export default MdblistRatingBadges;
