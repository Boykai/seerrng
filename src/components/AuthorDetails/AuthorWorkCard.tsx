import CachedImage from '@app/components/Common/CachedImage';
import SelectionCircle from '@app/components/Common/SelectionCircle';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import { encodeApiPathSegment } from '@app/utils/apiPath';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { BookResult } from '@server/models/Book';
import Link from 'next/link';

export const getBookFormatState = (
  work: BookResult,
  format: 'ebook' | 'audiobook'
): 'available' | 'requested' | 'unavailable' => {
  const media = work.mediaInfo;
  const available =
    format === 'ebook'
      ? media?.serviceId != null && media.externalServiceId != null
      : media?.audiobookServiceId != null &&
        media.audiobookExternalServiceId != null;
  if (available) return 'available';
  const requested = (media?.requests ?? []).some(
    (request) =>
      request.status !== MediaRequestStatus.DECLINED &&
      request.status !== MediaRequestStatus.FAILED &&
      request.status !== MediaRequestStatus.COMPLETED &&
      (request.bookFormat === 'both' ||
        (request.bookFormat ?? 'ebook') === format)
  );
  return requested ? 'requested' : 'unavailable';
};

export default function AuthorWorkCard({
  work,
  author,
  selected,
  onToggle,
}: {
  work: BookResult;
  author: string;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const href = `/book/${encodeApiPathSegment(work.id)}`;
  const bookState = getBookFormatState(work, 'ebook');
  const audioState = getBookFormatState(work, 'audiobook');
  const status = (state: ReturnType<typeof getBookFormatState>) => (
    <AvailabilityValue
      status={
        state === 'available'
          ? MediaStatus.AVAILABLE
          : state === 'requested'
            ? MediaStatus.PENDING
            : MediaStatus.UNKNOWN
      }
    >
      {state === 'available'
        ? 'Available'
        : state === 'requested'
          ? 'Requested'
          : 'Not Available'}
    </AvailabilityValue>
  );

  return (
    <article
      className={[
        'detail-summary-card movie-summary-card app-card-sub detail-item-surface',
        onToggle ? 'movie-summary-card-with-selection' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {onToggle && (
        <div className="movie-summary-selection">
          <SelectionCircle
            label={`Select ${work.title} for this collection request`}
            selected={!!selected}
            onClick={onToggle}
          />
        </div>
      )}
      <div className="collection-summary-poster">
        <CachedImage
          type="book"
          src={work.posterPath || '/images/seerr_poster_not_found.png'}
          alt=""
          fill
          sizes="80px"
          className="collection-summary-poster-image"
        />
        <Link
          href={href}
          aria-label={work.title}
          className="movie-summary-poster-link"
        />
      </div>
      <div className="flex min-w-0 flex-col">
        <h3 className="movie-summary-title">
          <Link href={href} className="catalog-item-title">
            {work.title}
            {work.firstPublishYear ? ` (${work.firstPublishYear})` : ''}
          </Link>
        </h3>
        <div className="detail-card-heading-spacing detail-three-column-grid grid min-w-0 flex-1">
          <div className="detail-paired-column-span min-w-0">
            <dl className="media-detail-rows detail-paired-columns grid min-w-0 content-start text-xs">
              <dt className="card:col-start-1 card:row-start-1 font-medium text-gray-100">
                Media &amp; Format:
              </dt>
              <dd className="card:col-start-3 card:row-start-1 m-0 truncate">
                Book · Audiobook
              </dd>
              <dt className="card:col-start-1 card:row-start-2 font-medium text-gray-100">
                First Published:
              </dt>
              <dd className="card:col-start-3 card:row-start-2 m-0 truncate">
                {work.firstPublishYear || 'Not Available'}
              </dd>
              <dt className="card:col-start-1 card:row-start-3 font-medium text-gray-100">
                Editions:
              </dt>
              <dd className="card:col-start-3 card:row-start-3 m-0 truncate">
                {work.editionCount || 'Not Available'}
              </dd>
              <div className="media-detail-rows media-detail-column-divider card:col-span-1 card:col-start-5 card:row-span-3 card:row-start-1 col-span-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3">
                <dt className="font-medium text-gray-100">Author:</dt>
                <dd className="m-0 truncate">{author}</dd>
                <dt className="font-medium text-gray-100">ISBN:</dt>
                <dd className="m-0 truncate">
                  {work.isbn13 || 'Not Available'}
                </dd>
                <dt className="font-medium text-gray-100">Publisher:</dt>
                <dd className="m-0 truncate">
                  {work.publisher || 'Not Available'}
                </dd>
              </div>
              <dt className="card:col-start-1 card:row-start-4 font-medium text-gray-100">
                Genres:
              </dt>
              <dd className="card:col-span-3 card:col-start-3 card:row-start-4 m-0 min-w-0">
                Not Available
              </dd>
            </dl>
          </div>
          <div className="media-detail-column-divider flex min-w-0 flex-col text-xs">
            <dl className="media-detail-rows grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3">
              <dt className="font-medium text-gray-100">Book:</dt>
              <dd className="m-0">{status(bookState)}</dd>
              <dt className="font-medium text-gray-100">Audiobook:</dt>
              <dd className="m-0">{status(audioState)}</dd>
            </dl>
          </div>
        </div>
      </div>
    </article>
  );
}
