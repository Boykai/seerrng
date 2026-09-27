import Tooltip from '@app/components/Common/Tooltip';
import { StarIcon } from '@heroicons/react/24/solid';
import { useIntl } from 'react-intl';

export default function BookRating({
  average,
  count,
  source,
  href,
}: {
  average?: number;
  count?: number;
  source: 'Open Library' | 'Bookshelf';
  href?: string;
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
  const label = `${source} rating: ${score}/5 from ${intl.formatNumber(count)} ratings`;
  const content = (
    <>
      <StarIcon className="media-rating-icon text-amber-300" aria-hidden />
      <span className="media-rating-value">
        {source} {score}/5
      </span>
    </>
  );

  return (
    <Tooltip content={label}>
      {href ? (
        <a
          className="media-rating-link"
          aria-label={label}
          href={href}
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
