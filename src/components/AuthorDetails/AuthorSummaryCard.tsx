import CollectionOverview from '@app/components/CollectionDetails/CollectionOverview';
import CachedImage from '@app/components/Common/CachedImage';
import type { AuthorDetails } from '@server/models/Book';

export default function AuthorSummaryCard({
  author,
  selectionSize,
}: {
  author: AuthorDetails;
  selectionSize?: { selected: number; visible: number };
}) {
  return (
    <section className="app-card-sub detail-item-surface detail-summary-card collection-summary-header">
      <div className="collection-summary-poster">
        <CachedImage
          type="book"
          src={author.posterPath || '/images/seerr_poster_not_found.png'}
          alt=""
          fill
          sizes="80px"
          className="collection-summary-poster-image"
        />
      </div>
      <div className="collection-summary-details">
        <h1 className="collection-summary-title">{author.name} Bibliography</h1>
        <dl className="collection-summary-table detail-card-heading-spacing">
          <dt className="collection-summary-overview-label">Overview:</dt>
          <dd className="collection-summary-overview-value bibliography-overview-clamp">
            <CollectionOverview text={author.biography || '—'} />
          </dd>
          <dt className="collection-summary-genres-label">Dates:</dt>
          <dd className="collection-summary-genres-value">
            {[author.birthDate, author.deathDate].filter(Boolean).join(' – ') ||
              'Not Available'}
          </dd>
          <div className="collection-summary-size">
            <dt className="collection-summary-size-label">
              Bibliography Size:
            </dt>
            <dd className="collection-summary-size-value">
              {author.pagination.totalItems}
            </dd>
            {selectionSize && (
              <>
                <dt className="collection-summary-selection-label">
                  Selection Size:
                </dt>
                <dd className="collection-summary-selection-value">
                  {selectionSize.selected} / {selectionSize.visible}
                </dd>
              </>
            )}
          </div>
        </dl>
      </div>
    </section>
  );
}
