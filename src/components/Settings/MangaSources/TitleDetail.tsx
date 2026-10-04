import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import { mangaAvailabilityMessages } from '@app/components/MangaDetails/mangaAvailability';
import AvailabilityValue from '@app/components/MediaDetails/AvailabilityValue';
import {
  bindingStatus,
  ConfidenceBadge,
  MatchedBy,
} from '@app/components/Settings/MangaLibrary';
import {
  messages as libraryMessages,
  trackingMessages,
} from '@app/components/Settings/MangaLibrary/messages';
import {
  describeResolveError,
  detailMessages,
  languageMessages,
  messages,
  requestMessages,
  sourceMessages,
} from '@app/components/Settings/MangaSources/messages';
import type {
  BindBody,
  BindProblem,
} from '@app/components/Settings/MangaSources/requestBodies';
import {
  bindByMangaId,
  bindBySource,
  RESOLVE_API,
  resolveDetailKey,
  searchBody,
  selectBody,
} from '@app/components/Settings/MangaSources/requestBodies';
import {
  CheckDate,
  StatusBadges,
  StatusFailure,
  StatusReason,
} from '@app/components/Settings/MangaSources/TitleStatus';
import useMangaSummaries from '@app/hooks/useMangaSummaries';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowPathIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
import type { MangaLibraryBinding } from '@server/interfaces/api/mangaLibraryInterfaces';
import type {
  MangaResolveBindResponse,
  MangaResolveCandidate,
  MangaResolveDetail,
  MangaResolveSearchResponse,
} from '@server/interfaces/api/mangaResolveInterfaces';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import axios from 'axios';
import Link from 'next/link';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const DETAIL_POLL_MS = 5_000;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The shared Modal puts its dialog inside the backdrop it forwards.
const dialogIn = (backdrop: HTMLElement | null): HTMLElement | null =>
  backdrop?.querySelector<HTMLElement>('[role="dialog"]') ?? null;

type Area = 'status' | 'suggestions' | 'hand';

interface Failure {
  area: Area;
  text: string;
  /** Sends the same write again. */
  retry?: () => void;
}

type Confirm =
  { kind: 'search' } | { kind: 'select'; candidate: MangaResolveCandidate };

interface SourceOption {
  id: string;
  label: string;
}

const FailureRow = ({ failure, busy }: { failure: Failure; busy: boolean }) => {
  const intl = useIntl();

  return (
    <>
      <p className="error" role="alert">
        {failure.text}
      </p>
      {failure.retry && (
        <div className="settings-page-actions">
          <Button
            buttonType="default"
            buttonSize="standard"
            disabled={busy}
            onClick={failure.retry}
          >
            <ArrowPathIcon />
            <span>{intl.formatMessage(globalMessages.retry)}</span>
          </Button>
        </div>
      )}
    </>
  );
};

const ConfirmPanel = ({
  text,
  warning,
  busy,
  panelRef,
  onConfirm,
  onCancel,
}: {
  text: string;
  warning?: string;
  busy: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const intl = useIntl();
  const id = useId();

  return (
    // The panel takes the focus, not a button: the app-wide button help
    // would cover the question and the warning.
    <div
      ref={panelRef}
      className="settings-library-card settings-manga-sources-confirm"
      role="group"
      tabIndex={-1}
      aria-labelledby={`${id}-text`}
      aria-describedby={warning ? `${id}-warning` : undefined}
    >
      <p id={`${id}-text`}>{text}</p>
      {warning && (
        <p id={`${id}-warning`} className="warning">
          {warning}
        </p>
      )}
      <div className="settings-page-actions">
        <Button
          buttonType="danger"
          buttonSize="standard"
          buttonIcon="cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {intl.formatMessage(globalMessages.cancel)}
        </Button>
        <Button
          buttonType="success"
          buttonSize="standard"
          disabled={busy}
          aria-describedby={warning ? `${id}-text ${id}-warning` : `${id}-text`}
          onClick={onConfirm}
        >
          <CheckIcon />
          <span>{intl.formatMessage(trackingMessages.confirm)}</span>
        </Button>
      </div>
    </div>
  );
};

const BindingCard = ({
  binding,
  source,
}: {
  binding: MangaLibraryBinding;
  source: string;
}) => {
  const intl = useIntl();
  const status = bindingStatus(binding);

  return (
    <li className="settings-library-card">
      <div className="settings-manga-sources-item-body">
        {binding.title && (
          <span className="settings-manga-sources-item-title">
            {binding.title}
          </span>
        )}
        <dl className="settings-service-details">
          <dt>{intl.formatMessage(sourceMessages.source)}</dt>
          <dd>{source}</dd>
        </dl>
        <div className="settings-service-badges">
          <MatchedBy binding={binding} />
          <AvailabilityValue tone={status.tone}>
            {intl.formatMessage(status.message)}
          </AvailabilityValue>
        </div>
      </div>
    </li>
  );
};

const CandidateCard = ({
  candidate,
  busy,
  onMatch,
  children,
}: {
  candidate: MangaResolveCandidate;
  busy: boolean;
  onMatch: (trigger: HTMLElement) => void;
  children?: ReactNode;
}) => {
  const intl = useIntl();
  const id = useId();

  return (
    <li className="settings-library-card">
      <div className="settings-manga-sources-item">
        <div className="settings-manga-sources-item-body">
          <span
            id={`${id}-title`}
            className="settings-manga-sources-item-title"
          >
            {candidate.title}
          </span>
          <dl className="settings-service-details">
            <dt>{intl.formatMessage(sourceMessages.source)}</dt>
            <dd>{candidate.sourceName || candidate.sourceId}</dd>
            {candidate.sourceLang && (
              <>
                <dt>{intl.formatMessage(languageMessages.language)}</dt>
                <dd>{candidate.sourceLang}</dd>
              </>
            )}
          </dl>
          <div className="settings-service-badges">
            {/* A title match is a suggestion: show its confidence, never
                MatchedBy, whose title case reads as confirmed. */}
            {candidate.matchedBy === 'mangadex-link' ? (
              <MatchedBy binding={candidate} />
            ) : (
              <ConfidenceBadge confidence={candidate.confidence} />
            )}
            {candidate.inLibrary && (
              <AvailabilityValue tone="processing">
                {intl.formatMessage(
                  mangaAvailabilityMessages.inSuwayomiLibrary
                )}
              </AvailabilityValue>
            )}
          </div>
        </div>
        <Button
          buttonType="success"
          buttonSize="standard"
          disabled={busy}
          aria-describedby={`${id}-title`}
          onClick={(event) => onMatch(event.currentTarget)}
        >
          <CheckIcon />
          <span>{intl.formatMessage(libraryMessages.match)}</span>
        </Button>
      </div>
      {children}
    </li>
  );
};

/**
 * Binds by Suwayomi manga ID, or by source and source-relative URL when the
 * instance's sources are known. Each form sends only its own fields.
 */
const HandForms = ({
  instanceId,
  sources,
  busy,
  onBind,
}: {
  instanceId: number;
  sources?: SourceOption[];
  busy: boolean;
  onBind: (key: string, body: BindBody) => void;
}) => {
  const intl = useIntl();
  const id = useId();
  const [mangaId, setMangaId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<BindProblem | null>(null);
  const mangaIdRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const refuse = (found: BindProblem) => {
    setProblem(found);
    const field = {
      mangaId: mangaIdRef,
      source: sourceRef,
      url: urlRef,
    }[found];
    field.current?.focus();
  };

  const submitMangaId = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = bindByMangaId(instanceId, mangaId);
    if (result.problem) {
      refuse(result.problem);
      return;
    }
    setProblem(null);
    onBind('bind-manga-id', result.body);
  };

  const submitSource = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = bindBySource(instanceId, sourceId, url);
    if (result.problem) {
      refuse(result.problem);
      return;
    }
    setProblem(null);
    onBind('bind-source', result.body);
  };

  const fieldProps = (kind: BindProblem) => ({
    id: `${id}-${kind}`,
    'aria-invalid': problem === kind || undefined,
    'aria-describedby': problem === kind ? `${id}-${kind}-error` : undefined,
  });

  const fieldError = (kind: BindProblem, message: MessageDescriptor) =>
    problem === kind ? (
      <div id={`${id}-${kind}-error`} className="error" role="alert">
        {intl.formatMessage(message)}
      </div>
    ) : null;

  const submit = (
    <div className="settings-page-actions">
      <Button
        type="submit"
        buttonType="success"
        buttonSize="standard"
        disabled={busy}
      >
        <CheckIcon />
        <span>{intl.formatMessage(libraryMessages.match)}</span>
      </Button>
    </div>
  );

  return (
    <>
      <form noValidate onSubmit={submitMangaId}>
        <div className="form-row">
          <label htmlFor={`${id}-mangaId`} className="text-label">
            {intl.formatMessage(messages.mangaId)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <input
                ref={mangaIdRef}
                {...fieldProps('mangaId')}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={mangaId}
                onChange={(event) => {
                  setMangaId(event.target.value);
                  if (problem === 'mangaId') setProblem(null);
                }}
              />
            </div>
            {fieldError('mangaId', messages.invalidMangaId)}
          </div>
        </div>
        {submit}
      </form>
      {sources && (
        <form noValidate onSubmit={submitSource}>
          <div className="form-row">
            <label htmlFor={`${id}-source`} className="text-label">
              {intl.formatMessage(sourceMessages.source)}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <select
                  ref={sourceRef}
                  {...fieldProps('source')}
                  value={sourceId}
                  onChange={(event) => {
                    setSourceId(event.target.value);
                    if (problem === 'source') setProblem(null);
                  }}
                >
                  <option value="">
                    {intl.formatMessage(messages.chooseSource)}
                  </option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </div>
              {fieldError('source', messages.invalidSource)}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor={`${id}-url`} className="text-label">
              {intl.formatMessage(messages.url)}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <input
                  ref={urlRef}
                  {...fieldProps('url')}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    if (problem === 'url') setProblem(null);
                  }}
                />
              </div>
              {fieldError('url', messages.invalidUrl)}
            </div>
          </div>
          {submit}
        </form>
      )}
    </>
  );
};

interface TitleDetailProps {
  anilistId: number;
  instanceId: number;
  /** Opened by Search Now on a title whose request is not approved. */
  confirmSearch?: boolean;
  onClose: () => void;
  onListChange: () => Promise<unknown>;
}

/**
 * One parked title: its status, live matches and suggestions, a search and
 * a match by hand. Confirms are inline, so the dialog never nests another.
 */
const TitleDetail = ({
  anilistId,
  instanceId,
  confirmSearch = false,
  onClose,
  onListChange,
}: TitleDetailProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const id = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(
    confirmSearch ? { kind: 'search' } : null
  );
  // `searchedAt` when this view queued a search; undefined until it does.
  const [queuedSearchedAt, setQueuedSearchedAt] = useState<string | null>();
  const [polling, setPolling] = useState(false);

  const detail = useSWR<MangaResolveDetail>(
    resolveDetailKey(anilistId, instanceId),
    // The app-wide 30-second dedupe would swallow every poll.
    { refreshInterval: polling ? DETAIL_POLL_MS : 0, dedupingInterval: 1_000 }
  );
  const instances = useSWR<SuwayomiSettingsView[]>('/api/v1/settings/suwayomi');
  const titles = useMangaSummaries([anilistId]);
  const data = detail.data;

  // Poll while a search waits, until it ran: `searchedAt` changes or the
  // request clears.
  const searching =
    Boolean(data?.searchRequestedAt) &&
    (queuedSearchedAt === undefined || data?.searchedAt === queuedSearchedAt);
  useEffect(() => setPolling(searching), [searching]);

  const busy = busyKey !== null;
  const searchConfirmVisible =
    confirm?.kind === 'search' && data !== undefined && !data.approved;
  const selectConfirmVisible =
    confirm?.kind === 'select' &&
    (data?.candidates.some(
      (candidate) => candidate.id === confirm.candidate.id
    ) ??
      false);
  const confirmVisible = searchConfirmVisible || selectConfirmVisible;

  // Focus enters the dialog on open, returns to a closed confirm's trigger,
  // and comes back into the dialog after a write disabled the focused
  // control. It waits for the write, as a busy trigger is still disabled.
  useEffect(() => {
    if (busyKey !== null) return;
    const dialog = dialogIn(backdropRef.current);
    if (!dialog) return;
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected && dialog.contains(restore)) {
      restore.focus();
    } else if (restore || !dialog.contains(document.activeElement)) {
      dialog.setAttribute('tabindex', '-1');
      dialog.focus({ preventScroll: true });
    }
  }, [busyKey, confirm]);

  useEffect(() => {
    if (confirmVisible) confirmPanelRef.current?.focus();
  }, [confirmVisible, confirm]);

  const closeConfirm = () => {
    restoreFocusRef.current =
      confirmTriggerRef.current ?? dialogIn(backdropRef.current);
    confirmTriggerRef.current = null;
    setConfirm(null);
  };

  // Tab stays inside the dialog; Escape cancels an open confirm first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogIn(backdropRef.current);
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (busyRef.current) return;
        if (confirmVisible) {
          closeConfirm();
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const openConfirm = (next: Confirm, trigger: HTMLElement) => {
    confirmTriggerRef.current = trigger;
    setFailure(null);
    setConfirm(next);
  };

  /** One write at a time; both views reload before the next can start. */
  const run = async <T,>(
    area: Area,
    key: string,
    request: () => Promise<{ data: T }>,
    again: () => void
  ): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusyKey(key);
    setFailure(null);
    try {
      return (await request()).data;
    } catch (error) {
      const described = describeResolveError(intl, error);
      setFailure({
        area,
        text: described.text,
        retry: described.retry ? again : undefined,
      });
      if (described.reload) {
        confirmTriggerRef.current = null;
        setConfirm(null);
      }
      return undefined;
    } finally {
      await Promise.allSettled([detail.mutate(), onListChange()]);
      busyRef.current = false;
      setBusyKey(null);
    }
  };

  const saved = () => {
    addToast(intl.formatMessage(libraryMessages.matchSaved), {
      appearance: 'success',
      autoDismiss: true,
    });
    onClose();
  };

  const search = async (confirmed: boolean) => {
    const result = await run<MangaResolveSearchResponse>(
      'status',
      'search',
      () =>
        axios.post(
          `${RESOLVE_API}/${anilistId}/search`,
          searchBody(instanceId)
        ),
      () => void search(confirmed)
    );
    if (!result) return;
    setQueuedSearchedAt(result.title.searchedAt);
    if (confirmed) closeConfirm();
  };

  const searchNow = (trigger: HTMLElement) => {
    if (!data) return;
    if (data.approved) {
      void search(false);
    } else {
      openConfirm({ kind: 'search' }, trigger);
    }
  };

  const select = async (candidate: MangaResolveCandidate) => {
    const result = await run<MangaResolveBindResponse>(
      'suggestions',
      `select-${candidate.id}`,
      () =>
        axios.post(
          `${RESOLVE_API}/${anilistId}/select`,
          selectBody(instanceId, candidate.id)
        ),
      () => void select(candidate)
    );
    if (result) saved();
  };

  const bind = async (key: string, body: BindBody) => {
    const result = await run<MangaResolveBindResponse>(
      'hand',
      key,
      () => axios.post(`${RESOLVE_API}/${anilistId}/bind`, body),
      () => void bind(key, body)
    );
    if (result) saved();
  };

  const refresh = () => {
    setFailure(null);
    void Promise.allSettled([detail.mutate(), onListChange()]);
  };

  const summary = titles.summaries.get(anilistId);
  const instanceList = instances.data ?? [];
  const instance = instanceList.find((item) => item.id === instanceId);
  const sourceName = (sourceId: string): string =>
    data?.candidates.find(
      (candidate) => candidate.sourceId === sourceId && candidate.sourceName
    )?.sourceName ?? sourceId;
  // Local sources ('0') can't be bound.
  const allowed = instance?.sourceAllowlist.filter((source) => source !== '0');
  const sources = allowed?.length
    ? allowed.map((source) => ({ id: source, label: sourceName(source) }))
    : undefined;
  const hasActiveBinding =
    data?.bindings.some((binding) => {
      const state: string = binding.state;
      return state === 'ACTIVE';
    }) ?? false;

  const refreshButton = (
    <Button
      buttonType="default"
      buttonSize="standard"
      disabled={busy}
      onClick={refresh}
    >
      <ArrowPathIcon />
      <span>{intl.formatMessage(requestMessages.refresh)}</span>
    </Button>
  );

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        ref={backdropRef}
        title={
          summary?.title ??
          intl.formatMessage(
            titles.isLoading
              ? globalMessages.loading
              : libraryMessages.unknownTitle,
            { id: anilistId }
          )
        }
        subTitle={instanceList.length > 1 ? instance?.name : undefined}
        onCancel={() => {
          if (!busyRef.current) onClose();
        }}
        cancelText={intl.formatMessage(globalMessages.close)}
        cancelButtonType="danger"
        cancelButtonProps={{ disabled: busy }}
        manageHistory={false}
        alignTop
      >
        {!data ? (
          detail.error ? (
            <>
              <p className="error" role="alert">
                {describeResolveError(intl, detail.error).text}
              </p>
              <div className="settings-page-actions">{refreshButton}</div>
            </>
          ) : (
            <LoadingSpinner />
          )
        ) : (
          <>
            <section
              className="settings-group-card"
              aria-labelledby={`${id}-status`}
            >
              <h4 id={`${id}-status`} className="settings-group-heading">
                {intl.formatMessage(globalMessages.status)}
              </h4>
              <div className="settings-manga-sources-stack">
                <div role="status">
                  <StatusBadges title={data} />
                </div>
                <StatusReason
                  title={data}
                  matches={[...data.bindings, ...data.candidates]}
                />
                <StatusFailure title={data} />
              </div>
              {(data.checkedAt || data.nextAttemptAt) && (
                <dl className="settings-service-details">
                  {data.checkedAt && (
                    <>
                      <dt>{intl.formatMessage(messages.lastCheck)}</dt>
                      <dd>
                        <CheckDate value={data.checkedAt} />
                      </dd>
                    </>
                  )}
                  {data.nextAttemptAt && (
                    <>
                      <dt>{intl.formatMessage(messages.nextCheck)}</dt>
                      <dd>
                        <CheckDate value={data.nextAttemptAt} />
                      </dd>
                    </>
                  )}
                </dl>
              )}
              <p className="settings-group-description">
                <Link
                  href={`/requests?requestId=${data.requestId}`}
                  className="settings-manga-sources-link"
                >
                  {intl.formatMessage(detailMessages.viewRequest)}
                </Link>
              </p>
              {failure?.area === 'status' && (
                <FailureRow failure={failure} busy={busy} />
              )}
              {searchConfirmVisible && (
                <ConfirmPanel
                  text={intl.formatMessage(messages.searchConfirm)}
                  busy={busy}
                  panelRef={confirmPanelRef}
                  onConfirm={() => void search(true)}
                  onCancel={closeConfirm}
                />
              )}
              <div className="settings-page-actions">
                {refreshButton}
                <Button
                  buttonType="primary"
                  buttonSize="standard"
                  disabled={busy}
                  onClick={(event) => searchNow(event.currentTarget)}
                >
                  <MagnifyingGlassIcon />
                  <span>{intl.formatMessage(messages.searchNow)}</span>
                </Button>
              </div>
            </section>
            {data.bindings.length > 0 && (
              <section
                className="settings-group-card"
                aria-labelledby={`${id}-matches`}
              >
                <h4 id={`${id}-matches`} className="settings-group-heading">
                  {intl.formatMessage(libraryMessages.matches)}
                </h4>
                <ul className="settings-manga-sources-list">
                  {data.bindings.map((binding) => (
                    <BindingCard
                      key={binding.id}
                      binding={binding}
                      source={sourceName(binding.sourceId)}
                    />
                  ))}
                </ul>
              </section>
            )}
            <section
              className="settings-group-card"
              aria-labelledby={`${id}-suggestions`}
            >
              <h4 id={`${id}-suggestions`} className="settings-group-heading">
                {intl.formatMessage(messages.suggestions)}
              </h4>
              {failure?.area === 'suggestions' && (
                <FailureRow failure={failure} busy={busy} />
              )}
              {data.candidates.length === 0 ? (
                <p className="settings-group-description">
                  {intl.formatMessage(globalMessages.noresults)}
                </p>
              ) : (
                <ul className="settings-manga-sources-list">
                  {data.candidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.id}
                      candidate={candidate}
                      busy={busy}
                      onMatch={(trigger) =>
                        openConfirm({ kind: 'select', candidate }, trigger)
                      }
                    >
                      {confirm?.kind === 'select' &&
                        confirm.candidate.id === candidate.id && (
                          <ConfirmPanel
                            text={intl.formatMessage(messages.selectConfirm, {
                              title: candidate.title,
                            })}
                            warning={
                              hasActiveBinding
                                ? intl.formatMessage(messages.secondBinding)
                                : undefined
                            }
                            busy={busy}
                            panelRef={confirmPanelRef}
                            onConfirm={() => void select(candidate)}
                            onCancel={closeConfirm}
                          />
                        )}
                    </CandidateCard>
                  ))}
                </ul>
              )}
            </section>
            <section
              className="settings-group-card"
              aria-labelledby={`${id}-hand`}
            >
              <h4 id={`${id}-hand`} className="settings-group-heading">
                {intl.formatMessage(messages.bindByHand)}
              </h4>
              {instance && !sources ? (
                <p className="settings-group-description">
                  {intl.formatMessage(messages.noSources, {
                    link: (chunks: ReactNode) => (
                      <Link
                        href="/settings/services"
                        className="settings-manga-sources-link"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              ) : (
                <>
                  <p className="settings-group-description">
                    {intl.formatMessage(messages.bindTip, {
                      form: sources ? 'source' : 'other',
                    })}
                  </p>
                  {failure?.area === 'hand' && (
                    <FailureRow failure={failure} busy={busy} />
                  )}
                  <HandForms
                    instanceId={instanceId}
                    sources={sources}
                    busy={busy}
                    onBind={(key, body) => void bind(key, body)}
                  />
                </>
              )}
            </section>
          </>
        )}
      </Modal>
    </Transition>
  );
};

export default TitleDetail;
