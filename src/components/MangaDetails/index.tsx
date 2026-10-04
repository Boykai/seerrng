import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import { MangaWaitingStatus } from '@app/components/Common/MangaRequestScope';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import ExternalBlocklistModal from '@app/components/ExternalBlocklistModal';
import MangaChapterList from '@app/components/MangaDetails/MangaChapterList';
import { getMangaAvailability } from '@app/components/MangaDetails/mangaAvailability';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import MediaDetailArtwork from '@app/components/MediaDetails/MediaDetailArtwork';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { encodeApiPathSegment } from '@app/utils/apiPath';
import defineMessages from '@app/utils/defineMessages';
import { getMangaImageUrl } from '@app/utils/mangaImages';
import {
  getMangaAniListId,
  isAwaitingMangaSource,
  type MangaScopedRequest,
} from '@app/utils/mangaRequestScope';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  InformationCircleIcon,
  MinusCircleIcon,
  StarIcon,
} from '@heroicons/react/24/solid';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MangaDetails as MangaDetailsType } from '@server/models/Manga';
import axios from 'axios';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const RequestModal = dynamic(() => import('@app/components/RequestModal'), {
  ssr: false,
});

const IssueModal = dynamic(() => import('@app/components/IssueModal'), {
  ssr: false,
});

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
  viewRequest: 'View Request',
  reportissue: 'Report an Issue',
  formatManga: 'Manga',
  formatOneShot: 'One Shot',
  formatNovel: 'Novel',
  statusFinished: 'Finished',
  statusReleasing: 'Releasing',
  statusNotYetReleased: 'Not Yet Released',
  statusCancelled: 'Cancelled',
  statusHiatus: 'Hiatus',
  watchlistSuccess: '<strong>{title}</strong> added to watchlist successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist successfully!',
  watchlistError: 'Something went wrong. Please try again.',
  removefromwatchlist: 'Remove From Watchlist',
  addtowatchlist: 'Add To Watchlist',
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
  const settings = useSettings();
  const { addToast } = useToasts();
  const { user, hasPermission } = useUser();
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const [isBlocklisting, setIsBlocklisting] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [editRequest, setEditRequest] = useState<MangaScopedRequest>();
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [isWatchlistUpdating, setIsWatchlistUpdating] = useState(false);
  const [toggleWatchlist, setToggleWatchlist] = useState(true);
  const mangaId =
    typeof router.query.mangaId === 'string' ? router.query.mangaId : '';

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MangaDetailsType>(
    mangaId ? `/api/v1/manga/${encodeApiPathSegment(mangaId)}` : null
  );
  const activeRequests =
    data?.mediaInfo?.requests?.filter(
      (request) =>
        request.status === MediaRequestStatus.PENDING ||
        request.status === MediaRequestStatus.APPROVED
    ) ?? [];
  // Other users' requests can arrive without a requester, so a match needs
  // the loaded user.
  const activeRequest =
    activeRequests.find(
      (request) => user !== undefined && request.requestedBy?.id === user.id
    ) ??
    (hasPermission(Permission.MANAGE_REQUESTS) && activeRequests.length === 1
      ? activeRequests[0]
      : undefined);
  // Only the request endpoint says whether an approved request is parked.
  const { data: activeRequestData } = useSWR<MangaScopedRequest>(
    activeRequest?.status === MediaRequestStatus.APPROVED
      ? `/api/v1/request/${activeRequest.id}`
      : null
  );

  useEffect(() => {
    setToggleWatchlist(!data?.onUserWatchlist);
  }, [data?.onUserWatchlist]);

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
  // Every user type keeps manga on the SeerrNG watchlist.
  const canWatchlist =
    aniListId !== undefined &&
    data.mediaInfo?.status !== MediaStatus.BLOCKLISTED;
  const mediaStatus = data.mediaInfo?.status;
  const canShowRequestButton =
    !!settings.currentSettings.suwayomiEnabled &&
    aniListId !== undefined &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MANGA], {
      type: 'or',
    }) &&
    (mediaStatus === undefined ||
      mediaStatus === MediaStatus.UNKNOWN ||
      mediaStatus === MediaStatus.DELETED ||
      mediaStatus === MediaStatus.PARTIALLY_AVAILABLE) &&
    activeRequests.length === 0;
  const canUseReportIssue = hasPermission(
    [Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES],
    { type: 'or' }
  );
  const isReportIssueAvailable =
    !!data.mediaInfo?.id &&
    (data.mediaInfo.status === MediaStatus.AVAILABLE ||
      data.mediaInfo.status === MediaStatus.PARTIALLY_AVAILABLE);
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

  const updateWatchlist = async (): Promise<void> => {
    const adding = toggleWatchlist;
    setIsWatchlistUpdating(true);

    try {
      if (adding) {
        await axios.post('/api/v1/watchlist', {
          externalId: String(data.id),
          mediaType: MediaType.MANGA,
          title: data.title,
        });
      } else {
        await axios.delete(
          `/api/v1/watchlist/${encodeApiPathSegment(String(data.id))}?mediaType=manga`
        );
      }
      addToast(
        <span>
          {intl.formatMessage(
            adding ? messages.watchlistSuccess : messages.watchlistDeleted,
            {
              title: data.title,
              strong: (message: React.ReactNode) => (
                <strong key="strong">{message}</strong>
              ),
            }
          )}
        </span>,
        { appearance: adding ? 'success' : 'info', autoDismiss: true }
      );
      setToggleWatchlist(!adding);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsWatchlistUpdating(false);
      void revalidate();
    }
  };
  const watchlistLabel = intl.formatMessage(
    toggleWatchlist ? messages.addtowatchlist : messages.removefromwatchlist
  );

  return (
    <>
      <PageTitle title={data.title} />
      {showIssueModal && (
        <IssueModal
          show={showIssueModal}
          mediaType="manga"
          mediaId={data.mediaInfo?.id}
          title={data.title}
          backdrop={posterSrc}
          onCancel={() => setShowIssueModal(false)}
        />
      )}
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
      {showRequestModal && aniListId !== undefined && (
        <RequestModal
          type="manga"
          mangaId={aniListId}
          editRequest={editRequest}
          show={showRequestModal}
          onComplete={() => {
            setEditRequest(undefined);
            setShowRequestModal(false);
            void revalidate();
          }}
          onCancel={() => {
            setEditRequest(undefined);
            setShowRequestModal(false);
          }}
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
                  {activeRequests.length > 0 && (
                    <>
                      <dt className="font-medium text-gray-100">
                        {intl.formatMessage(globalMessages.request)}:
                      </dt>
                      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1">
                        {!activeRequest ? (
                          // Another user's request: its parked state is not
                          // visible here, so never claim it is approved.
                          intl.formatMessage(globalMessages.requested)
                        ) : isAwaitingMangaSource(activeRequestData) ? (
                          <MangaWaitingStatus
                            showHint={hasPermission(Permission.MANAGE_REQUESTS)}
                            anilistId={getMangaAniListId(
                              activeRequestData?.media
                            )}
                            instanceId={activeRequestData?.serverId}
                          />
                        ) : (
                          intl.formatMessage(
                            activeRequest.status === MediaRequestStatus.APPROVED
                              ? globalMessages.approved
                              : globalMessages.pending
                          )
                        )}
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
              {canWatchlist && (
                <Tooltip content={watchlistLabel}>
                  <Button
                    buttonType={toggleWatchlist ? 'ghost' : 'default'}
                    buttonSize="sm"
                    onClick={updateWatchlist}
                    aria-label={watchlistLabel}
                  >
                    {isWatchlistUpdating ? (
                      <Spinner />
                    ) : toggleWatchlist ? (
                      <StarIcon data-icon-tone="accent" />
                    ) : (
                      <MinusCircleIcon />
                    )}
                  </Button>
                </Tooltip>
              )}
              {canUseReportIssue && (
                <Tooltip
                  content={intl.formatMessage(
                    isReportIssueAvailable
                      ? messages.reportissue
                      : globalMessages.reportIssueUnavailable
                  )}
                >
                  <Button
                    buttonType="reportIssue"
                    buttonSize="sm"
                    onClick={() => setShowIssueModal(true)}
                    disabled={!isReportIssueAvailable}
                    disabledReason={intl.formatMessage(
                      globalMessages.reportIssueUnavailable
                    )}
                    aria-label={intl.formatMessage(messages.reportissue)}
                  >
                    <ExclamationTriangleIcon />
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
              {activeRequest && aniListId !== undefined && (
                <Button
                  buttonType="ghost"
                  buttonSize="sm"
                  onClick={() => {
                    setEditRequest(activeRequest);
                    setShowRequestModal(true);
                  }}
                >
                  <InformationCircleIcon />
                  <span>{intl.formatMessage(messages.viewRequest)}</span>
                </Button>
              )}
              {canShowRequestButton && (
                <Button
                  buttonType="primary"
                  buttonSize="sm"
                  onClick={() => {
                    setEditRequest(undefined);
                    setShowRequestModal(true);
                  }}
                >
                  <ArrowDownTrayIcon />
                  <span>{intl.formatMessage(globalMessages.request)}</span>
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
            {settings.currentSettings.suwayomiEnabled &&
              aniListId !== undefined &&
              isBlocklistAvailable && (
                <MangaChapterList key={aniListId} mangaId={aniListId} />
              )}
          </div>
        </article>
        <div className="extra-bottom-space relative" />
      </div>
    </>
  );
};

export default MangaDetails;
