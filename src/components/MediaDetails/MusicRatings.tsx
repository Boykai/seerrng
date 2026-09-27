import DiscogsLogo from '@app/assets/discogs.svg';
import MusicBrainzLogo from '@app/assets/musicbrainz.svg';
import LidarrLogo from '@app/assets/services/lidarr.svg';
import TheAudioDBLogo from '@app/assets/theaudiodb.svg';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import type { DisplayMusicRating } from '@app/utils/musicRatings';
import { getSafeHref } from '@app/utils/safeUrl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MusicRatings', {
  score: '{source}: {score}/{scale} from {votes} votes.',
  average:
    '{source}: {score}/{scale}, average of {count} rated albums out of {total}. Missing ratings are excluded.',
  absent: '{source}: no rating available.',
  edition:
    'Discogs rating is for the linked release or the master entry’s main release, not every edition.',
});
const names = {
  musicbrainz: 'MusicBrainz',
  lidarr: 'Lidarr',
  theaudiodb: 'TheAudioDB',
  discogs: 'Discogs',
};
export default function MusicRatings({
  ratings = [],
  total,
  albumId,
  albumTitle,
  artist,
}: {
  ratings?: DisplayMusicRating[];
  total?: number;
  albumId?: string;
  albumTitle?: string;
  artist?: string;
}) {
  const intl = useIntl();
  const sources = (
    ['musicbrainz', 'lidarr', 'theaudiodb', 'discogs'] as const
  ).filter((source) =>
    source === 'lidarr'
      ? ratings.some((rating) => rating.source === source)
      : source !== 'musicbrainz' ||
        !ratings.some((rating) => rating.source === 'lidarr') ||
        ratings.some((rating) => rating.source === 'musicbrainz')
  );
  return (
    <>
      {sources.map((source) => {
        const rating = ratings.find((value) => value.source === source);
        const scale = rating?.scale ?? (source === 'discogs' ? 5 : 10);
        const title =
          (rating
            ? intl.formatMessage(
                total === undefined ? messages.score : messages.average,
                {
                  source: names[source],
                  score: intl.formatNumber(rating.score, {
                    maximumFractionDigits: 1,
                  }),
                  scale,
                  votes: intl.formatNumber(rating.votes),
                  count: rating.ratedAlbums ?? 0,
                  total: total ?? 0,
                }
              )
            : intl.formatMessage(messages.absent, { source: names[source] })) +
          (source === 'discogs'
            ? ' ' + intl.formatMessage(messages.edition)
            : '');
        const content = (
          <>
            {source === 'musicbrainz' ? (
              <MusicBrainzLogo className="media-rating-icon" aria-hidden />
            ) : source === 'lidarr' ? (
              <LidarrLogo className="media-rating-icon" aria-hidden />
            ) : source === 'theaudiodb' ? (
              <TheAudioDBLogo className="media-rating-wordmark" aria-hidden />
            ) : (
              <DiscogsLogo className="media-rating-wordmark" aria-hidden />
            )}
            <span className="media-rating-value">
              {rating
                ? `${intl.formatNumber(rating.score, { maximumFractionDigits: 1 })}/${scale}`
                : '—'}
            </span>
          </>
        );
        const search = [artist, albumTitle].filter(Boolean).join(' ');
        const fallbackHref =
          source === 'musicbrainz' &&
          albumId &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(albumId)
            ? `https://musicbrainz.org/release-group/${albumId}`
            : source === 'theaudiodb'
              ? 'https://www.theaudiodb.com/browse.php'
              : source === 'discogs' && search
                ? `https://www.discogs.com/search/?q=${encodeURIComponent(search)}&type=all`
                : source === 'discogs'
                  ? 'https://www.discogs.com/'
                  : 'https://musicbrainz.org/';
        const href = getSafeHref(rating?.url) ?? fallbackHref;
        return (
          <Tooltip key={source} content={title}>
            <a
              className="media-rating-link"
              aria-label={title}
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {content}
            </a>
          </Tooltip>
        );
      })}
    </>
  );
}
