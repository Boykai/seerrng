import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PaginationFooter from '@app/components/Common/PaginationFooter';
import Table from '@app/components/Common/Table';
import { CompactSelect } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import { messages as libraryMessages } from '@app/components/Settings/MangaLibrary/messages';
import {
  describeResolveError,
  getStatusLabel,
  messages,
  settingsMessages,
} from '@app/components/Settings/MangaSources/messages';
import type { ListStatus } from '@app/components/Settings/MangaSources/requestBodies';
import {
  isAnilistId,
  isInstanceId,
  isListStatus,
  LIST_STATUSES,
  RESOLVE_API,
  resolveListKey,
  searchBody,
} from '@app/components/Settings/MangaSources/requestBodies';
import {
  CheckDate,
  StatusBadges,
  StatusFailure,
  StatusReason,
} from '@app/components/Settings/MangaSources/TitleStatus';
import useMangaSummaries from '@app/hooks/useMangaSummaries';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import {
  getPositiveQueryParamNumber,
  useQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { getMangaImageUrl } from '@app/utils/mangaImages';
import { isConfiguredMediaCategoryEnabled } from '@app/utils/serviceAvailability';
import { MagnifyingGlassIcon, PencilIcon } from '@heroicons/react/24/solid';
import type {
  MangaResolveTitle,
  MangaResolveTitlesResponse,
} from '@server/interfaces/api/mangaResolveInterfaces';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import axios from 'axios';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ParsedUrlQuery } from 'querystring';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const TitleDetail = dynamic(
  () => import('@app/components/Settings/MangaSources/TitleDetail')
);

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 10;
const LIST_POLL_MS = 10_000;
const COLUMNS = 5;

type TitleRef = Pick<MangaResolveTitle, 'anilistId' | 'instanceId'>;

const titleKey = ({ anilistId, instanceId }: TitleRef): string =>
  `${anilistId}:${instanceId}`;

// Digits only: Number() would also read '', ' 1', '1e3' and '0x1'.
const readId = (value: ParsedUrlQuery[string]): number | undefined =>
  typeof value === 'string' && /^\d{1,10}$/.test(value)
    ? Number(value)
    : undefined;

/**
 * Requested titles that wait for a Suwayomi source. A title's detail opens
 * from `?anilistId=&instanceId=`, so links and reloads open it too.
 */
const MangaSources = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { addToast } = useToasts();
  const mangaEnabled = isConfiguredMediaCategoryEnabled(
    'manga',
    settings.currentSettings
  );
  const page = getPositiveQueryParamNumber(router.query.page, 1) ?? 1;
  const updateQueryParams = useUpdateQueryParams({
    page: page > 1 ? page.toString() : undefined,
  });
  const updateQuery = useQueryParams();
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [status, setStatus] = useState<ListStatus | ''>('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [polling, setPolling] = useState(false);
  const [confirmSearchFor, setConfirmSearchFor] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const searchTriggerRef = useRef<HTMLElement | null>(null);
  const pushedRef = useRef(false);

  const list = useSWR<MangaResolveTitlesResponse>(
    mangaEnabled ? resolveListKey(page, pageSize, status || undefined) : null,
    // The app-wide 30-second dedupe would swallow every poll.
    { refreshInterval: polling ? LIST_POLL_MS : 0, dedupingInterval: 2_000 }
  );
  const instances = useSWR<SuwayomiSettingsView[]>(
    mangaEnabled ? '/api/v1/settings/suwayomi' : null
  );
  const titles = list.data?.results;
  const summaries = useMangaSummaries(
    (titles ?? []).map((title) => title.anilistId)
  );

  const queryAnilistId = readId(router.query.anilistId);
  const queryInstanceId = readId(router.query.instanceId);
  const selected: TitleRef | null =
    isAnilistId(queryAnilistId) && isInstanceId(queryInstanceId)
      ? { anilistId: queryAnilistId, instanceId: queryInstanceId }
      : null;
  const selectedKey = selected ? titleKey(selected) : null;

  // Poll while a row waits for its queued search.
  const waiting =
    titles?.some((title) => title.searchRequestedAt !== null) ?? false;
  useEffect(() => setPolling(waiting), [waiting]);

  // A search can empty the last page; step back to the new last page.
  const pages = list.data?.pageInfo.pages ?? 0;
  useEffect(() => {
    if (pages > 0 && page > pages) {
      updateQueryParams('page', pages.toString());
    }
  }, [page, pages, updateQueryParams]);

  // Focus returns to the control that opened the detail, else the heading.
  const shownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const shown = shownKeyRef.current;
    shownKeyRef.current = selectedKey;
    if (shown === null || selectedKey !== null) return;
    pushedRef.current = false;
    setConfirmSearchFor(null);
    const opener = openerRef.current;
    openerRef.current = null;
    (opener?.isConnected ? opener : headingRef.current)?.focus();
  }, [selectedKey]);

  // A list search disables its button; give the focus back afterwards.
  useEffect(() => {
    if (busyKey !== null) return;
    const trigger = searchTriggerRef.current;
    searchTriggerRef.current = null;
    if (
      trigger?.isConnected &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      trigger.focus();
    }
  }, [busyKey]);

  if (!mangaEnabled || list.error?.response?.status === 404) {
    return <ErrorPage statusCode={404} />;
  }

  const busy = busyKey !== null;
  const instanceList = instances.data ?? [];
  const showInstance = instanceList.length > 1;

  const openDetail = (
    title: MangaResolveTitle,
    opener: HTMLElement,
    confirmSearch = false
  ) => {
    if (selectedKey !== null) return;
    openerRef.current = opener;
    pushedRef.current = true;
    setConfirmSearchFor(confirmSearch ? titleKey(title) : null);
    updateQuery(
      {
        anilistId: title.anilistId.toString(),
        instanceId: title.instanceId.toString(),
      },
      'push',
      { shallow: true, scroll: false }
    );
  };

  const closeDetail = () => {
    if (pushedRef.current) {
      router.back();
      return;
    }
    updateQuery({ anilistId: undefined, instanceId: undefined }, 'replace', {
      shallow: true,
      scroll: false,
    });
  };

  const searchNow = async (title: MangaResolveTitle, trigger: HTMLElement) => {
    // An unapproved title confirms the external contact in its detail.
    if (!title.approved) {
      openDetail(title, trigger, true);
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    searchTriggerRef.current = trigger;
    setBusyKey(titleKey(title));
    try {
      await axios.post(
        `${RESOLVE_API}/${title.anilistId}/search`,
        searchBody(title.instanceId)
      );
      addToast(intl.formatMessage(messages.searchQueued), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (error) {
      addToast(describeResolveError(intl, error).text, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      await list.mutate().catch(() => undefined);
      busyRef.current = false;
      setBusyKey(null);
    }
  };

  const changePage = (next: number) =>
    updateQueryParams('page', next > 1 ? next.toString() : undefined);

  const statusOptions = [
    { value: '', label: intl.formatMessage(globalMessages.all) },
    ...LIST_STATUSES.flatMap((value) => {
      const label = getStatusLabel(value);
      return label ? [{ value, label: intl.formatMessage(label.message) }] : [];
    }),
  ];

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(settingsMessages.menuMangaSources),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      {selected && (
        <TitleDetail
          key={selectedKey}
          anilistId={selected.anilistId}
          instanceId={selected.instanceId}
          confirmSearch={confirmSearchFor === selectedKey}
          onClose={closeDetail}
          onListChange={() => list.mutate()}
        />
      )}
      <div className="mb-6">
        <h3 ref={headingRef} className="heading" tabIndex={-1}>
          {intl.formatMessage(settingsMessages.menuMangaSources)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="app-card-sub section">
        <div className="settings-log-toolbar">
          <CompactSelect
            label={intl.formatMessage(globalMessages.status)}
            value={status}
            options={statusOptions}
            defaultValue=""
            onChange={(value) => {
              setStatus(isListStatus(value) ? value : '');
              changePage(1);
            }}
          />
        </div>
        <Table className="settings-manga-sources-table">
          <thead>
            <tr>
              <Table.TH>
                {intl.formatMessage(libraryMessages.aniListTitle)}
              </Table.TH>
              <Table.TH className="settings-manga-sources-status-column">
                {intl.formatMessage(globalMessages.status)}
              </Table.TH>
              <Table.TH className="settings-manga-sources-check-column">
                {intl.formatMessage(messages.lastCheck)}
              </Table.TH>
              <Table.TH className="settings-manga-sources-check-column">
                {intl.formatMessage(messages.nextCheck)}
              </Table.TH>
              <Table.TH className="settings-manga-sources-actions-column" />
            </tr>
          </thead>
          <Table.TBody>
            {!titles ? (
              <tr>
                <Table.TD colSpan={COLUMNS} alignText="center">
                  {list.error ? (
                    intl.formatMessage(globalMessages.error)
                  ) : (
                    <LoadingSpinner />
                  )}
                </Table.TD>
              </tr>
            ) : titles.length === 0 ? (
              <tr>
                <Table.TD colSpan={COLUMNS} alignText="center">
                  {intl.formatMessage(
                    status ? globalMessages.noresults : messages.empty
                  )}
                </Table.TD>
              </tr>
            ) : (
              titles.map((title) => {
                const rowKey = titleKey(title);
                const summary = summaries.summaries.get(title.anilistId);
                const instance = instanceList.find(
                  (item) => item.id === title.instanceId
                );

                return (
                  <tr key={rowKey}>
                    <Table.TD>
                      <div className="settings-manga-sources-title">
                        <div className="settings-manga-sources-cover">
                          <CachedImage
                            type="tmdb"
                            src={
                              getMangaImageUrl(summary?.posterPath) ??
                              '/images/seerr_poster_not_found.png'
                            }
                            alt=""
                            sizes="28px"
                            fill
                          />
                        </div>
                        <div className="settings-manga-sources-title-body">
                          {/* A missing summary is never explained here. */}
                          {summary ? (
                            <Link
                              href={`/manga/${title.anilistId}`}
                              className="settings-manga-sources-link"
                            >
                              {summary.title}
                            </Link>
                          ) : (
                            <span>
                              {summaries.isLoading
                                ? intl.formatMessage(globalMessages.loading)
                                : intl.formatMessage(
                                    libraryMessages.unknownTitle,
                                    { id: title.anilistId }
                                  )}
                            </span>
                          )}
                          {showInstance && instance && (
                            <span>{instance.name}</span>
                          )}
                        </div>
                      </div>
                    </Table.TD>
                    <Table.TD>
                      <div className="settings-manga-sources-stack">
                        <StatusBadges title={title} />
                        <StatusReason title={title} />
                        <StatusFailure title={title} />
                      </div>
                    </Table.TD>
                    <Table.TD>
                      <CheckDate value={title.checkedAt} />
                    </Table.TD>
                    <Table.TD>
                      <CheckDate value={title.nextAttemptAt} />
                    </Table.TD>
                    <Table.TD alignText="right">
                      <div className="settings-table-action-row">
                        <Button
                          buttonType="primary"
                          buttonSize="standard"
                          disabled={busy}
                          onClick={(event) =>
                            openDetail(title, event.currentTarget)
                          }
                        >
                          <PencilIcon />
                          <span>{intl.formatMessage(globalMessages.open)}</span>
                        </Button>
                        <Button
                          buttonType="default"
                          buttonSize="standard"
                          disabled={busy}
                          onClick={(event) =>
                            void searchNow(title, event.currentTarget)
                          }
                        >
                          <MagnifyingGlassIcon />
                          <span>{intl.formatMessage(messages.searchNow)}</span>
                        </Button>
                      </div>
                    </Table.TD>
                  </tr>
                );
              })
            )}
          </Table.TBody>
        </Table>
        <PaginationFooter
          defaultPageSize={DEFAULT_PAGE_SIZE}
          page={page}
          pageSize={pageSize}
          totalPages={pages}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={changePage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            changePage(1);
          }}
        />
      </div>
    </>
  );
};

export default MangaSources;
