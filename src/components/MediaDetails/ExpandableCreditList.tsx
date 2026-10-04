import CachedImage from '@app/components/Common/CachedImage';
import PageErrorMessage, {
  type MessageRetry,
} from '@app/components/Common/PageErrorMessage';
import Link from 'next/link';

export interface ExpandableCredit {
  id: number;
  name: string;
  role: string;
  profilePath?: string;
}

interface ExpandableCreditListProps {
  title: string;
  credits: ExpandableCredit[];
  emptyLabel: string;
  retry?: MessageRetry;
}

const ExpandableCreditList = ({
  title,
  credits,
  emptyLabel,
  retry,
}: ExpandableCreditListProps) => (
  <section className="app-card-inset refreshed-inset-surface card-spacing-before">
    <h2 className="media-inset-heading card-spacing-after">{title}</h2>
    {credits.length === 0 ? (
      <PageErrorMessage title={emptyLabel} severity="empty" retry={retry} />
    ) : (
      <div
        className="card-list scrollable-card"
        data-list-layout="portrait"
        data-scroll-layout="portrait"
      >
        {credits.map((credit, index) => (
          <div
            key={`${credit.id}-${credit.role}-${index}`}
            data-card-size="compact"
            data-card-layout="portrait"
            className="app-card-sub detail-item-surface detail-item-interactive"
          >
            <span data-card-part="artwork">
              <CachedImage
                type="tmdb"
                src={
                  credit.profilePath
                    ? `https://image.tmdb.org/t/p/w185${credit.profilePath}`
                    : '/images/camera-shy-profile-placeholder.png'
                }
                alt=""
                fill
                sizes="54px"
              />
            </span>
            <span data-card-part="content">
              <Link
                href={`/person/${credit.id}`}
                prefetch={false}
                className="card-title"
              >
                {credit.name}
              </Link>
              <span className="card-subheading">{credit.role}</span>
            </span>
          </div>
        ))}
      </div>
    )}
  </section>
);

export default ExpandableCreditList;
