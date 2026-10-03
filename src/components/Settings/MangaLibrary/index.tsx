import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PaginationFooter from '@app/components/Common/PaginationFooter';
import Table from '@app/components/Common/Table';
import { CompactSelect } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import type { MangaAvailability } from '@app/components/MangaDetails/mangaAvailability';
import { getMangaAvailability } from '@app/components/MangaDetails/mangaAvailability';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import {
  describeMangaLibraryError,
  getProposalStrength,
  messages,
  requestMessages,
  settingsMessages,
  trackingMessages,
} from '@app/components/Settings/MangaLibrary/messages';
import type { MangaSummaries } from '@app/hooks/useMangaSummaries';
import useMangaSummaries from '@app/hooks/useMangaSummaries';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import {
  getPositiveQueryParamNumber,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { isConfiguredMediaCategoryEnabled } from '@app/utils/serviceAvailability';
import { CheckIcon, PencilIcon, XMarkIcon } from '@heroicons/react/24/solid';
import type {
  MangaLibraryBinding,
  MangaLibraryBindingsResponse,
  MangaLibraryCandidate,
  MangaLibraryCandidatesResponse,
} from '@server/interfaces/api/mangaLibraryInterfaces';
import axios from 'axios';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const BindModal = dynamic(
  () => import('@app/components/Settings/MangaLibrary/BindModal')
);

const API = '/api/v1/manga/library';
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 10;

/** The natural key of a library item; `url` is sent, never shown. */
interface LibraryItem {
  instanceId: number;
  sourceId: string;
  url: string;
  title: string | null;
}

const toLibraryItem = ({
  instanceId,
  sourceId,
  url,
  title,
}: LibraryItem): LibraryItem => ({ instanceId, sourceId, url, title });

const MANGADEX_URL = 'https://mangadex.org/';

const AnilistTitle = ({
  anilistId,
  summaries,
}: {
  anilistId: number;
  summaries: MangaSummaries;
}) => {
  const intl = useIntl();
  const manga = summaries.summaries.get(anilistId);

  if (manga) {
    return (
      <Link
        href={`/manga/${anilistId}`}
        className="settings-manga-library-link"
      >
        {manga.title}
      </Link>
    );
  }

  // Hidden by the Manga Content settings, unknown, or not loaded.
  return (
    <span>
      {summaries.isLoading
        ? intl.formatMessage(globalMessages.loading)
        : intl.formatMessage(messages.unknownTitle, { id: anilistId })}
    </span>
  );
};

const ScanTip = () => {
  const intl = useIntl();

  return (
    <>
      {intl.formatMessage(messages.scanTip, {
        link: (chunks: ReactNode) => (
          <Link href="/settings/jobs" className="settings-manga-library-link">
            {chunks}
          </Link>
        ),
      })}
    </>
  );
};

const ConfidenceBadge = ({ confidence }: { confidence: string }) => {
  const intl = useIntl();
  const strength = getProposalStrength(confidence);

  return strength ? (
    <Badge badgeType={strength.badgeType}>
      {intl.formatMessage(strength.message)}
    </Badge>
  ) : null;
};

const MatchedBy = ({ binding }: { binding: MangaLibraryBinding }) => {
  const intl = useIntl();

  switch (binding.matchedBy) {
    case 'anilist-tracker':
      return <span>{intl.formatMessage(messages.anilistTracker)}</span>;
    case 'mal-tracker':
      return <span>{intl.formatMessage(messages.malTracker)}</span>;
    case 'mangadex-link':
      return (
        <span>
          {intl.formatMessage(messages.mangadexLink, {
            link: (chunks: ReactNode) => (
              <a
                href={MANGADEX_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="settings-manga-library-link"
              >
                {chunks}
              </a>
            ),
          })}
        </span>
      );
    case 'title':
      return (
        <div className="settings-manga-library-stack">
          <span>{intl.formatMessage(messages.confirmedByAdmin)}</span>
          <ConfidenceBadge confidence={binding.confidence} />
        </div>
      );
    case 'manual':
      return <span>{intl.formatMessage(messages.chosenByAdmin)}</span>;
    default:
      return null;
  }
};

const bindingStatus = (binding: MangaLibraryBinding): MangaAvailability => {
  const state: string = binding.state;

  if (state === 'ORPHANED') {
    return { message: messages.notInLibrary, tone: 'unavailable' };
  }
  if (state === 'REJECTED') {
    return { message: messages.rejected, tone: 'unavailable' };
  }
  return (
    getMangaAvailability(binding.availability, binding.inLibrary) ?? {
      message: requestMessages.active,
      tone: 'processing',
    }
  );
};

const RejectButton = ({
  disabled,
  onReject,
}: {
  disabled: boolean;
  onReject: () => void;
}) => {
  const intl = useIntl();
  const label = (
    <>
      <XMarkIcon />
      <span>{intl.formatMessage(messages.reject)}</span>
    </>
  );

  // ConfirmButton has no disabled state.
  return disabled ? (
    <Button buttonType="danger" buttonSize="standard" disabled>
      {label}
    </Button>
  ) : (
    <ConfirmButton
      buttonSize="standard"
      confirmText={intl.formatMessage(globalMessages.areyousure)}
      onClick={onReject}
    >
      {label}
    </ConfirmButton>
  );
};

const ChooseTitleButton = ({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) => {
  const intl = useIntl();

  return (
    <Button
      buttonType="primary"
      buttonSize="standard"
      disabled={disabled}
      onClick={onClick}
    >
      <PencilIcon />
      <span>{intl.formatMessage(messages.chooseTitle)}</span>
    </Button>
  );
};

const SavingButton = () => {
  const intl = useIntl();

  return (
    <Button buttonType="primary" buttonSize="standard" disabled>
      <span>{intl.formatMessage(globalMessages.saving)}</span>
    </Button>
  );
};

const listKey = (
  path: string,
  page: number,
  pageSize: number,
  filter: Record<string, string>
): string => {
  const query = [
    `take=${pageSize}`,
    `skip=${(page - 1) * pageSize}`,
    ...Object.entries(filter)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`),
  ].join('&');

  return `${API}/${path}?${query}`;
};

const MangaLibrary = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { addToast } = useToasts();
  const mangaEnabled = isConfiguredMediaCategoryEnabled(
    'manga',
    settings.currentSettings
  );
  const queuePage = getPositiveQueryParamNumber(router.query.queuePage, 1) ?? 1;
  const matchesPage =
    getPositiveQueryParamNumber(router.query.matchesPage, 1) ?? 1;
  const updateQueryParams = useUpdateQueryParams({
    queuePage: queuePage > 1 ? queuePage.toString() : undefined,
    matchesPage: matchesPage > 1 ? matchesPage.toString() : undefined,
  });
  const [queuePageSize, setQueuePageSize] = useState(DEFAULT_PAGE_SIZE);
  const [matchesPageSize, setMatchesPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [confidence, setConfidence] = useState('');
  const [state, setState] = useState('ACTIVE');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [bindTarget, setBindTarget] = useState<LibraryItem | null>(null);

  const candidates = useSWR<MangaLibraryCandidatesResponse>(
    mangaEnabled
      ? listKey('candidates', queuePage, queuePageSize, { confidence })
      : null
  );
  const bindings = useSWR<MangaLibraryBindingsResponse>(
    mangaEnabled
      ? listKey('bindings', matchesPage, matchesPageSize, { state })
      : null
  );
  const proposalTitles = useMangaSummaries(
    (candidates.data?.results ?? []).flatMap((candidate) =>
      candidate.proposal ? [candidate.proposal.anilistId] : []
    )
  );
  const bindingTitles = useMangaSummaries(
    (bindings.data?.results ?? []).map((binding) => binding.anilistId)
  );

  // A decision can empty the last page; step back to the new last page.
  const queuePages = candidates.data?.pageInfo.pages ?? 0;
  const matchesPages = bindings.data?.pageInfo.pages ?? 0;
  useEffect(() => {
    if (queuePages > 0 && queuePage > queuePages) {
      updateQueryParams('queuePage', queuePages.toString());
    }
  }, [queuePage, queuePages, updateQueryParams]);
  useEffect(() => {
    if (matchesPages > 0 && matchesPage > matchesPages) {
      updateQueryParams('matchesPage', matchesPages.toString());
    }
  }, [matchesPage, matchesPages, updateQueryParams]);

  if (!mangaEnabled) {
    return <ErrorPage statusCode={404} />;
  }

  const busy = busyKey !== null;

  const decide = async (
    key: string,
    request: () => Promise<unknown>,
    success: MessageDescriptor
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyKey(key);
    try {
      await request();
      addToast(intl.formatMessage(success), {
        appearance: 'success',
        autoDismiss: true,
      });
      return true;
    } catch (error) {
      addToast(describeMangaLibraryError(intl, error), {
        appearance: 'error',
        autoDismiss: true,
      });
      return false;
    } finally {
      busyRef.current = false;
      setBusyKey(null);
      // Every decision can move rows between both lists.
      void candidates.mutate();
      void bindings.mutate();
    }
  };

  const confirmProposal = (candidate: MangaLibraryCandidate) => {
    const { proposal } = candidate;
    if (!proposal) return;
    void decide(
      `candidate-${candidate.id}`,
      () =>
        axios.post(`${API}/candidates/${candidate.id}/confirm`, {
          anilistId: proposal.anilistId,
        }),
      messages.matchSaved
    );
  };

  const reject = (key: string, item: LibraryItem, anilistId: number) => {
    void decide(
      key,
      () =>
        axios.post(`${API}/reject`, {
          instanceId: item.instanceId,
          sourceId: item.sourceId,
          url: item.url,
          anilistId,
        }),
      messages.matchRejected
    );
  };

  const bind = async (anilistId: number) => {
    const item = bindTarget;
    if (!item) return;
    const saved = await decide(
      'bind',
      () =>
        axios.post(`${API}/bind`, {
          instanceId: item.instanceId,
          anilistId,
          sourceId: item.sourceId,
          url: item.url,
        }),
      messages.matchSaved
    );
    if (saved) setBindTarget(null);
  };

  const changePage = (name: 'queuePage' | 'matchesPage', page: number) =>
    updateQueryParams(name, page > 1 ? page.toString() : undefined);

  const confidenceOptions = [
    { value: '', label: intl.formatMessage(globalMessages.all) },
    { value: 'HIGH', label: intl.formatMessage(messages.high) },
    { value: 'MEDIUM', label: intl.formatMessage(messages.medium) },
    { value: 'LOW', label: intl.formatMessage(messages.low) },
    { value: 'NONE', label: intl.formatMessage(messages.noProposal) },
  ];
  const stateOptions = [
    { value: 'ACTIVE', label: intl.formatMessage(requestMessages.active) },
    { value: 'ORPHANED', label: intl.formatMessage(messages.notInLibrary) },
    { value: 'REJECTED', label: intl.formatMessage(messages.rejected) },
    { value: '', label: intl.formatMessage(globalMessages.all) },
  ];
  const showScanTip =
    candidates.data !== undefined &&
    (candidates.data.results.length === 0 ||
      candidates.data.results.some((candidate) => !candidate.proposal));

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(settingsMessages.menuMangaLibrary),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      {bindTarget && (
        <BindModal
          libraryTitle={bindTarget.title}
          busy={busyKey === 'bind'}
          onBind={(anilistId) => void bind(anilistId)}
          onCancel={() => {
            if (!busyRef.current) setBindTarget(null);
          }}
        />
      )}
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.queue)}</h3>
        <p className="description">
          {intl.formatMessage(messages.queueDescription)}
        </p>
      </div>
      <div className="app-card-sub section">
        <div className="settings-log-toolbar">
          <CompactSelect
            label={intl.formatMessage(messages.confidence)}
            value={confidence}
            options={confidenceOptions}
            defaultValue=""
            onChange={(value) => {
              setConfidence(value);
              changePage('queuePage', 1);
            }}
          />
        </div>
        <Table className="settings-manga-library-table">
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.libraryTitle)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.proposal)}</Table.TH>
              <Table.TH className="settings-manga-library-candidate-actions-column" />
            </tr>
          </thead>
          <Table.TBody>
            {!candidates.data ? (
              <tr>
                <Table.TD colSpan={3} alignText="center">
                  {candidates.error ? (
                    intl.formatMessage(globalMessages.error)
                  ) : (
                    <LoadingSpinner />
                  )}
                </Table.TD>
              </tr>
            ) : candidates.data.results.length === 0 ? (
              <tr>
                <Table.TD colSpan={3} alignText="center">
                  {intl.formatMessage(messages.emptyQueue)}
                </Table.TD>
              </tr>
            ) : (
              candidates.data.results.map((candidate) => {
                const rowKey = `candidate-${candidate.id}`;
                const { proposal } = candidate;

                return (
                  <tr key={rowKey}>
                    <Table.TD>{candidate.title}</Table.TD>
                    <Table.TD>
                      {proposal ? (
                        <div className="settings-manga-library-stack">
                          <AnilistTitle
                            anilistId={proposal.anilistId}
                            summaries={proposalTitles}
                          />
                          <ConfidenceBadge confidence={proposal.confidence} />
                        </div>
                      ) : (
                        intl.formatMessage(messages.noProposal)
                      )}
                    </Table.TD>
                    <Table.TD alignText="right">
                      <div className="settings-table-action-row">
                        {busyKey === rowKey ? (
                          <SavingButton />
                        ) : (
                          <>
                            {proposal && (
                              <Button
                                buttonType="success"
                                buttonSize="standard"
                                disabled={busy}
                                onClick={() => confirmProposal(candidate)}
                              >
                                <CheckIcon />
                                <span>
                                  {intl.formatMessage(trackingMessages.confirm)}
                                </span>
                              </Button>
                            )}
                            <ChooseTitleButton
                              disabled={busy}
                              onClick={() =>
                                setBindTarget(toLibraryItem(candidate))
                              }
                            />
                            {proposal && (
                              <RejectButton
                                disabled={busy}
                                onReject={() =>
                                  reject(
                                    rowKey,
                                    toLibraryItem(candidate),
                                    proposal.anilistId
                                  )
                                }
                              />
                            )}
                          </>
                        )}
                      </div>
                    </Table.TD>
                  </tr>
                );
              })
            )}
          </Table.TBody>
        </Table>
        {showScanTip && (
          <p className="settings-form-row-description">
            <ScanTip />
          </p>
        )}
        <PaginationFooter
          defaultPageSize={DEFAULT_PAGE_SIZE}
          page={queuePage}
          pageSize={queuePageSize}
          totalPages={queuePages}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={(page) => changePage('queuePage', page)}
          onPageSizeChange={(size) => {
            setQueuePageSize(size);
            changePage('queuePage', 1);
          }}
        />
      </div>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.matches)}</h3>
        <p className="description">
          {intl.formatMessage(messages.matchesDescription)}
        </p>
      </div>
      <div className="app-card-sub section">
        <div className="settings-log-toolbar">
          <CompactSelect
            label={intl.formatMessage(globalMessages.status)}
            value={state}
            options={stateOptions}
            defaultValue="ACTIVE"
            onChange={(value) => {
              setState(value);
              changePage('matchesPage', 1);
            }}
          />
        </div>
        <Table className="settings-manga-library-table">
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.libraryTitle)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.aniListTitle)}</Table.TH>
              <Table.TH className="settings-manga-library-match-column">
                {intl.formatMessage(messages.match)}
              </Table.TH>
              <Table.TH className="settings-manga-library-status-column">
                {intl.formatMessage(globalMessages.status)}
              </Table.TH>
              <Table.TH className="settings-manga-library-binding-actions-column" />
            </tr>
          </thead>
          <Table.TBody>
            {!bindings.data ? (
              <tr>
                <Table.TD colSpan={5} alignText="center">
                  {bindings.error ? (
                    intl.formatMessage(globalMessages.error)
                  ) : (
                    <LoadingSpinner />
                  )}
                </Table.TD>
              </tr>
            ) : bindings.data.results.length === 0 ? (
              <tr>
                <Table.TD colSpan={5} alignText="center">
                  {intl.formatMessage(globalMessages.noresults)}
                </Table.TD>
              </tr>
            ) : (
              bindings.data.results.map((binding) => {
                const rowKey = `binding-${binding.id}`;
                const bindingState: string = binding.state;
                const status = bindingStatus(binding);

                return (
                  <tr key={rowKey}>
                    <Table.TD>{binding.title}</Table.TD>
                    <Table.TD>
                      <AnilistTitle
                        anilistId={binding.anilistId}
                        summaries={bindingTitles}
                      />
                    </Table.TD>
                    <Table.TD>
                      <MatchedBy binding={binding} />
                    </Table.TD>
                    <Table.TD>
                      <AvailabilityValue tone={status.tone}>
                        {intl.formatMessage(status.message)}
                      </AvailabilityValue>
                    </Table.TD>
                    <Table.TD alignText="right">
                      <div className="settings-table-action-row">
                        {busyKey === rowKey ? (
                          <SavingButton />
                        ) : (
                          <>
                            {bindingState !== 'ORPHANED' && (
                              <ChooseTitleButton
                                disabled={busy}
                                onClick={() =>
                                  setBindTarget(toLibraryItem(binding))
                                }
                              />
                            )}
                            {bindingState !== 'REJECTED' && (
                              <RejectButton
                                disabled={busy}
                                onReject={() =>
                                  reject(
                                    rowKey,
                                    toLibraryItem(binding),
                                    binding.anilistId
                                  )
                                }
                              />
                            )}
                          </>
                        )}
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
          page={matchesPage}
          pageSize={matchesPageSize}
          totalPages={matchesPages}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={(page) => changePage('matchesPage', page)}
          onPageSizeChange={(size) => {
            setMatchesPageSize(size);
            changePage('matchesPage', 1);
          }}
        />
      </div>
    </>
  );
};

export default MangaLibrary;
