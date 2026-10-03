import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import ExternalBlocklistModal from '@app/components/ExternalBlocklistModal';
import { getMangaAvailability } from '@app/components/MangaDetails/mangaAvailability';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import MediaDetailArtwork from '@app/components/MediaDetails/MediaDetailArtwork';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { encodeApiPathSegment } from '@app/utils/apiPath';
import defineMessages from '@app/utils/defineMessages';
import { getMangaImageUrl } from '@app/utils/mangaImages';
import {
  ArrowTopRightOnSquareIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/solid';
import { MediaStatus, MediaType } from '@server/constants/media';
import type { MangaDetails as MangaDetailsType } from '@server/models/Manga';
import axios from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MangaDetails', {
  format: 'Format',
  status: 'Status',
  chapters: 'Chapters',
  volumes: 'Volumes',
  availability: 'Availability',
  mangaDetails: 'Manga Details',
  startDate: 'Start Date',
  endDate: 'End Date',
  story: 'Story',
  art: 'Art',
  genres: 'Genres',
  tags: 'Tags',
  romajiTitle: 'Romaji Title',
  englishTitle: 'English Title',
  nativeTitle: 'Native Title',
  synonyms: 'Synonyms',
  overview: 'Overview',
  overviewUnavailable: 'Overview unavailable',
  notAvailable: 'Not available',
  viewOnAniList: 'View on AniList',
  viewOnMyAnimeList: 'View on MyAnimeList',
  formatManga: 'Manga',
  formatOneShot: 'One Shot',
  formatNovel: 'Novel',
  statusFinished: 'Finished',
  statusReleasing: 'Releasing',
  statusNotYetReleased: 'Not Yet Released',
  statusCancelled: 'Cancelled',
  statusHiatus: 'Hiatus',
});

type MessageKey = keyof typeof messages;
type DetailRow = [label: MessageKey, value?: string, wraps?: boolean];

const formatMessages: Record<
  NonNullable<MangaDetailsType['format']>,
  MessageKey
> = {
  MANGA: 'formatManga',
  ONE_SHOT: 'formatOneShot',
  NOVEL: 'formatNovel',
};

const statusMessages: Record<
  NonNullable<MangaDetailsType['status']>,
  MessageKey
> = {
  FINISHED: 'statusFinished',
  RELEASING: 'statusReleasing',
  NOT_YET_RELEASED: 'statusNotYetReleased',
  CANCELLED: 'statusCancelled',
  HIATUS: 'statusHiatus',
};

const positiveId = (value?: number): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

const joinValues = (values: string[]): string | undefined =>
  values.length > 0 ? values.join(', ') : undefined;

// AniList dates may be partial: a year, a year and month, or a full date.
const formatPartialDate = (
  intl: IntlShape,
  value?: string
): string | undefined => {
  const match = value?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  if (!month) {
    return year;
  }
  return intl.formatDate(
    Date.UTC(Number(year), Number(month) - 1, day ? Number(day) : 1),
    day
      ? { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }
      : { timeZone: 'UTC', year: 'numeric', month: 'long' }
  );
};

const MangaDetails = () => {
  const router = useRouter();
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const [isBlocklisting, setIsBlocklisting] = useState(false);
  const mangaId =
    typeof router.query.mangaId === 'string' ? router.query.mangaId : '';

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MangaDetailsType>(
    mangaId ? `/api/v1/manga/${encodeApiPathSegment(mangaId)}` : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const notAvailable = intl.formatMessage(messages.notAvailable);
  const posterSrc = getMangaImageUrl(data.posterPath);
  const artworkSrc = getMangaImageUrl(data.backdropPath) ?? posterSrc;
  const aniListId = positiveId(data.id);
  const malId = positiveId(data.idMal);
  const canUseBlocklist = hasPermission(Permission.MANAGE_BLOCKLIST);
  const isBlocklistAvailable =
    data.mediaInfo?.status !== MediaStatus.BLOCKLISTED;
  const availability = getMangaAvailability(
    data.mediaInfo?.status,
    data.inSuwayomiLibrary
  );
  const summaryRows: DetailRow[] = [
    [
      'format',
      data.format && intl.formatMessage(messages[formatMessages[data.format]]),
    ],
    [
      'status',
      data.status && intl.formatMessage(messages[statusMessages[data.status]]),
    ],
    [
      'chapters',
      data.chapters !== undefined
        ? intl.formatNumber(data.chapters)
        : undefined,
    ],
    [
      'volumes',
      data.volumes !== undefined ? intl.formatNumber(data.volumes) : undefined,
    ],
  ];
  // Genres and tags may wrap; every other value truncates to keep the grid.
  const detailGroups: DetailRow[][] = [
    [
      ['startDate', formatPartialDate(intl, data.startDate)],
      ['endDate', formatPartialDate(intl, data.endDate)],
      ['story', joinValues(data.story.map((credit) => credit.name))],
      ['art', joinValues(data.art.map((credit) => credit.name))],
    ],
    [
      ['genres', joinValues(data.genres), true],
      ['tags', joinValues(data.tags.map((tag) => tag.name)), true],
    ],
    [
      ['romajiTitle', data.titles.romaji],
      ['englishTitle', data.titles.english],
      ['nativeTitle', data.titles.native],
      ['synonyms', joinValues(data.synonyms)],
    ],
  ];

  const blocklistManga = async (): Promise<void> => {
    setIsBlocklisting(true);

    try {
      await axios.post('/api/v1/blocklist', {
        externalId: String(data.id),
        externalProvider: 'anilist',
        mediaType: MediaType.MANGA,
        title: data.title,
      });
      addToast(
        <span>
          {intl.formatMessage(globalMessages.blocklistSuccess, {
            title: data.title,
            strong: (message: React.ReactNode) => (
              <strong key="strong">{message}</strong>
            ),
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      void revalidate();
    } catch {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsBlocklisting(false);
      setShowBlocklistModal(false);
    }
  };

  return (
    <>
      <PageTitle title={data.title} />
      {showBlocklistModal && (
        <ExternalBlocklistModal
          show
          type="manga"
          title={data.title}
          backdrop={posterSrc}
          onCancel={() => setShowBlocklistModal(false)}
          onComplete={() => void blocklistManga()}
          isUpdating={isBlocklisting}
        />
      )}
      <div className="media-page">
        <article className="media-detail-card app-card-main refreshed-card-surface refreshed-detail-text relative overflow-hidden rounded-xl border border-gray-700 p-3 shadow-lg shadow-gray-950/20">
          {artworkSrc && <MediaDetailArtwork src={artworkSrc} type="tmdb" />}
          <div className="relative z-10">
            <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-3 sm:grid-cols-[80px_minmax(0,1fr)]">
              <div className="relative h-24 w-16 overflow-hidden rounded-lg ring-1 ring-gray-600 sm:h-[120px] sm:w-20">
                <CachedImage
                  type="tmdb"
                  src={posterSrc ?? '/images/seerr_poster_not_found.png'}
                  alt=""
                  fill
                  priority
                  sizes="(min-width: 640px) 80px, 64px"
                  className="object-cover"
                />
              </div>
              <div className="flex min-w-0 flex-col">
                <h1 className="text-lg leading-5 font-semibold text-white">
                  {data.title}
                  {data.startYear ? ` (${data.startYear})` : ''}
                </h1>
                <dl className="mt-4 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs leading-4">
                  {summaryRows.map(([label, value]) => (
                    <Fragment key={label}>
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(messages[label])}:
                      </dt>
                      <dd className="m-0 truncate">{value || notAvailable}</dd>
                    </Fragment>
                  ))}
                  {availability && (
                    <>
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(messages.availability)}:
                      </dt>
                      <dd className="m-0 truncate">
                        <AvailabilityValue tone={availability.tone}>
                          {intl.formatMessage(availability.message)}
                        </AvailabilityValue>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            </div>

            <div className="media-primary-action-row">
              {canUseBlocklist && (
                <Tooltip
                  content={intl.formatMessage(
                    isBlocklistAvailable
                      ? globalMessages.addToBlocklist
                      : globalMessages.alreadyBlocklisted
                  )}
                >
                  <Button
                    buttonType="blocklist"
                    buttonSize="sm"
                    onClick={() => setShowBlocklistModal(true)}
                    disabled={!isBlocklistAvailable}
                    disabledReason={intl.formatMessage(
                      globalMessages.alreadyBlocklisted
                    )}
                    aria-label={intl.formatMessage(
                      globalMessages.addToBlocklist
                    )}
                  >
                    <EyeSlashIcon />
                  </Button>
                </Tooltip>
              )}
              {aniListId && (
                <Button
                  as="a"
                  href={`https://anilist.co/manga/${aniListId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  buttonSize="sm"
                >
                  <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  <span>{intl.formatMessage(messages.viewOnAniList)}</span>
                </Button>
              )}
              {malId && (
                <Button
                  as="a"
                  href={`https://myanimelist.net/manga/${malId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  buttonSize="sm"
                >
                  <ArrowTopRightOnSquareIcon aria-hidden="true" />
                  <span>{intl.formatMessage(messages.viewOnMyAnimeList)}</span>
                </Button>
              )}
            </div>

            <section className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
              <h2 className="media-inset-heading">
                {intl.formatMessage(messages.overview)}
              </h2>
              {data.description ? (
                <div
                  data-testid="manga-description"
                  className="prose prose-sm prose-invert refreshed-detail-text-muted mt-4 max-w-none leading-5 break-words"
                  // AniList descriptions are sanitized by the server API
                  // adapter before they enter the detail response.
                  dangerouslySetInnerHTML={{ __html: data.description }}
                />
              ) : (
                <p className="refreshed-detail-text-muted mt-4 max-w-none text-sm leading-5">
                  {intl.formatMessage(messages.overviewUnavailable)}
                </p>
              )}
            </section>

            <section className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
              <h2 className="media-inset-heading detail-card-heading-after">
                {intl.formatMessage(messages.mangaDetails)}
              </h2>
              <div className="detail-three-column-grid grid">
                {detailGroups.map((rows, index) => (
                  <dl
                    key={rows[0][0]}
                    className={`media-detail-rows grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs ${
                      index > 0 ? 'media-detail-column-divider' : ''
                    }`}
                  >
                    {rows.map(([label, value, wraps]) => (
                      <Fragment key={label}>
                        <dt className="font-medium text-gray-100">
                          {intl.formatMessage(messages[label])}:
                        </dt>
                        <dd
                          className={
                            wraps ? 'm-0 min-w-0 break-words' : 'm-0 truncate'
                          }
                        >
                          {value || notAvailable}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                ))}
              </div>
            </section>
          </div>
        </article>
        <div className="extra-bottom-space relative" />
      </div>
    </>
  );
};

export default MangaDetails;
