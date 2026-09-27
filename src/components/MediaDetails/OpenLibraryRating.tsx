import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { StarIcon } from '@heroicons/react/24/solid';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.OpenLibraryRating', {
  rating: 'Open Library rating: {score}/5 from {votes} ratings',
});

export default function OpenLibraryRating({
  average,
  count,
  workId,
  interactive = true,
}: {
  average?: number;
  count?: number;
  workId: string;
  interactive?: boolean;
}) {
  const intl = useIntl();
  if (
    average === undefined ||
    !Number.isFinite(average) ||
    !count ||
    count < 1
  ) {
    return null;
  }

  const score = intl.formatNumber(average, { maximumFractionDigits: 1 });
  const label = intl.formatMessage(messages.rating, {
    score,
    votes: intl.formatNumber(count),
  });
  const content = (
    <>
      <StarIcon className="media-rating-icon text-amber-300" aria-hidden />
      <span className="media-rating-value">Open Library {score}/5</span>
    </>
  );

  return (
    <Tooltip content={label}>
      {interactive ? (
        <a
          className="media-rating-link"
          aria-label={label}
          href={`https://openlibrary.org/works/${encodeURIComponent(workId)}`}
          target="_blank"
          rel="noreferrer"
        >
          {content}
        </a>
      ) : (
        <span className="media-rating-link" aria-label={label}>
          {content}
        </span>
      )}
    </Tooltip>
  );
}
