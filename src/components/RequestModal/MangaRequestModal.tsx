import Alert from '@app/components/Common/Alert';
import CachedImage from '@app/components/Common/CachedImage';
import {
  MangaWaitingStatus,
  formatMangaScope,
  mangaScopeMessages,
} from '@app/components/Common/MangaRequestScope';
import Modal from '@app/components/Common/Modal';
import { getFilterToggleButtonClass } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import RequestFooterStatus from '@app/components/RequestModal/RequestFooterStatus';
import RequestMediaCard from '@app/components/RequestModal/RequestMediaCard';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { getMangaImageUrl } from '@app/utils/mangaImages';
import {
  MANGA_MAX_CHAPTER_NUMBER,
  MANGA_MAX_LATEST_COUNT,
  draftFromMangaScope,
  isAwaitingMangaSource,
  parseMangaScopeDraft,
  type MangaScopeDraft,
  type MangaScopeErrors,
  type MangaScopedRequest,
} from '@app/utils/mangaRequestScope';
import { ArrowDownTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { hasAutoApprovePermission } from '@server/lib/permissions';
import type { MangaDetails } from '@server/models/Manga';
import axios from 'axios';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal.Manga', {
  requestManga: 'Request Manga',
  pendingRequest: 'Pending Manga Request',
  mangaRequest: 'Manga Request',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestUpdated: 'Request for <strong>{title}</strong> updated.',
  requestCanceled: 'Request for <strong>{title}</strong> canceled.',
  cancelRequest: 'Cancel Request',
  pendingApproval: 'Your request is pending approval.',
  requestFrom: "{username}'s request is pending approval.",
  notFound: 'This manga could not be found.',
  tryLater: 'Manga details are unavailable right now. Try again later.',
  requestError: 'Something went wrong while submitting the request.',
  saveError: 'Something went wrong while saving the request.',
  cancelError: 'Something went wrong while canceling the request.',
  latestChapters: 'Latest chapters',
  chapterRange: 'Chapter range',
  scopeHelp: 'Chapters are chosen when the request is sent to Suwayomi.',
  latestCount: 'Number of chapters',
  rangeStart: 'From chapter',
  rangeEnd: 'To chapter (optional)',
  latestCountError: 'Enter a whole number from 1 to {max}.',
  chapterError: 'Enter a chapter number from 0 to {max}.',
  rangeOrderError: 'The last chapter must not be before the first.',
  approval: 'Approval',
  readyToRequest: 'Ready to Request',
});

const SCOPES = [
  MangaRequestScope.ALL_AT_DISPATCH,
  MangaRequestScope.LATEST_N,
  MangaRequestScope.RANGE,
];

const scopeLabels: Record<MangaRequestScope, MessageDescriptor> = {
  [MangaRequestScope.ALL_AT_DISPATCH]: mangaScopeMessages.allChapters,
  [MangaRequestScope.LATEST_N]: messages.latestChapters,
  [MangaRequestScope.RANGE]: messages.chapterRange,
};

const requestStatusLabels: Partial<
  Record<MediaRequestStatus, MessageDescriptor>
> = {
  [MediaRequestStatus.PENDING]: globalMessages.pending,
  [MediaRequestStatus.APPROVED]: globalMessages.approved,
  [MediaRequestStatus.DECLINED]: globalMessages.declined,
  [MediaRequestStatus.FAILED]: globalMessages.failed,
  [MediaRequestStatus.COMPLETED]: globalMessages.completed,
};

interface ErrorResponse {
  response?: { status?: number; data?: { message?: unknown } };
}

type NumberField = 'latestCount' | 'rangeStart' | 'rangeEnd';

interface MangaScopeFieldsProps {
  draft: MangaScopeDraft;
  errors: MangaScopeErrors;
  showErrors: boolean;
  disabled: boolean;
  onChange: (draft: MangaScopeDraft) => void;
}

const MangaScopeFields = ({
  draft,
  errors,
  showErrors,
  disabled,
  onChange,
}: MangaScopeFieldsProps) => {
  const intl = useIntl();
  const id = useId();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const moveTo = (index: number) => {
    const next = (index + SCOPES.length) % SCOPES.length;
    onChange({ ...draft, scope: SCOPES[next] });
    radios.current[next]?.focus();
  };

  const numberField = (
    field: NumberField,
    label: MessageDescriptor,
    inputMode: 'numeric' | 'decimal'
  ) => {
    const inputId = `${id}-${field}`;
    const error = errors[field];
    const message =
      error && (showErrors || draft[field].trim() !== '')
        ? error === 'beforeStart'
          ? intl.formatMessage(messages.rangeOrderError)
          : field === 'latestCount'
            ? intl.formatMessage(messages.latestCountError, {
                max: intl.formatNumber(MANGA_MAX_LATEST_COUNT),
              })
            : intl.formatMessage(messages.chapterError, {
                max: intl.formatNumber(MANGA_MAX_CHAPTER_NUMBER),
              })
        : undefined;

    return (
      <div key={field}>
        <label htmlFor={inputId} className="text-label">
          {intl.formatMessage(label)}
        </label>
        <input
          id={inputId}
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          className="short"
          value={draft[field]}
          disabled={disabled}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${inputId}-error` : undefined}
          onChange={(event) =>
            onChange({ ...draft, [field]: event.target.value })
          }
        />
        {message && (
          <p id={`${inputId}-error`} className="error" role="alert">
            {message}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
      <fieldset className="min-w-0">
        <legend className="group-label">
          {intl.formatMessage(mangaScopeMessages.chapters)}
        </legend>
        <div
          role="radiogroup"
          aria-label={intl.formatMessage(mangaScopeMessages.chapters)}
          aria-describedby={`${id}-help`}
          className="flex flex-wrap items-center gap-2"
        >
          {SCOPES.map((scope, index) => {
            const selected = draft.scope === scope;
            return (
              <button
                key={scope}
                ref={(element) => {
                  radios.current[index] = element;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                disabled={disabled}
                onClick={() => onChange({ ...draft, scope })}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveTo(index + 1);
                  } else if (
                    event.key === 'ArrowLeft' ||
                    event.key === 'ArrowUp'
                  ) {
                    event.preventDefault();
                    moveTo(index - 1);
                  }
                }}
                className={getFilterToggleButtonClass(selected)}
              >
                {intl.formatMessage(scopeLabels[scope])}
              </button>
            );
          })}
        </div>
        <p
          id={`${id}-help`}
          className="refreshed-detail-text-muted mt-2 text-xs"
        >
          {intl.formatMessage(messages.scopeHelp)}
        </p>
        {draft.scope !== MangaRequestScope.ALL_AT_DISPATCH && (
          <div className="mt-2 flex flex-wrap gap-3">
            {draft.scope === MangaRequestScope.LATEST_N
              ? numberField('latestCount', messages.latestCount, 'numeric')
              : [
                  numberField('rangeStart', messages.rangeStart, 'decimal'),
                  numberField('rangeEnd', messages.rangeEnd, 'decimal'),
                ]}
          </div>
        )}
      </fieldset>
    </div>
  );
};

interface MangaRequestModalProps {
  mangaId: number;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
  editRequest?: MangaScopedRequest;
}

const MangaRequestModal = ({
  mangaId,
  onCancel,
  onComplete,
  onUpdating,
  editRequest,
}: MangaRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user, hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const [draft, setDraft] = useState<MangaScopeDraft>();
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const mangaKey = `/api/v1/manga/${mangaId}`;
  const { data, error } = useSWR<MangaDetails>(mangaKey, {
    revalidateOnMount: true,
  });
  const { data: quota, error: quotaError } = useSWR<QuotaResponse>(
    user && !editRequest ? `/api/v1/user/${user.id}/quota` : null
  );
  const { data: requestData, error: requestError } = useSWR<MangaScopedRequest>(
    editRequest ? `/api/v1/request/${editRequest.id}` : null
  );

  useEffect(() => {
    onUpdating?.(isUpdating);
  }, [isUpdating, onUpdating]);

  const request = requestData ?? editRequest;
  const scopeSummary = request?.mangaScope;
  const formDraft = draft ?? draftFromMangaScope(scopeSummary);
  const { body, errors } = parseMangaScopeDraft(formDraft);
  const loadStatus = (error as ErrorResponse | undefined)?.response?.status;
  const loadError = error
    ? intl.formatMessage(
        loadStatus === 429 || loadStatus === 503
          ? messages.tryLater
          : loadStatus === 404
            ? messages.notFound
            : globalMessages.error
      )
    : undefined;
  const title = data?.title ?? '';
  const artwork =
    getMangaImageUrl(data?.backdropPath) ?? getMangaImageUrl(data?.posterPath);
  const poster =
    getMangaImageUrl(data?.posterPath) ?? '/images/seerr_poster_not_found.png';

  const errorMessage = (caught: unknown, fallback: MessageDescriptor) => {
    const status = (caught as ErrorResponse | undefined)?.response?.status;
    const message = (caught as ErrorResponse | undefined)?.response?.data
      ?.message;
    if (status === 404 && !editRequest) {
      return intl.formatMessage(messages.notFound);
    }
    if (status === 429 || status === 503) {
      return intl.formatMessage(messages.tryLater);
    }
    return (status === 400 || status === 403 || status === 409) &&
      typeof message === 'string' &&
      message
      ? message
      : intl.formatMessage(fallback);
  };

  // An auto-approver's request may approve an existing pending request
  // instead of creating one, so every list, count and status reloads.
  const revalidate = () => {
    void mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
    void mutate('/api/v1/request/count');
    void mutate(mangaKey);
    if (user) {
      void mutate(`/api/v1/user/${user.id}/quota`);
    }
    if (editRequest) {
      void mutate(`/api/v1/request/${editRequest.id}`);
    }
  };

  const toast = (message: MessageDescriptor) =>
    addToast(
      <span>
        {intl.formatMessage(message, {
          title,
          strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
        })}
      </span>,
      { appearance: 'success', autoDismiss: true }
    );

  const sendRequest = async () => {
    if (!body) {
      setShowErrors(true);
      return;
    }
    setIsUpdating(true);
    setSubmitError(undefined);
    try {
      const response = await axios.post<MangaScopedRequest>('/api/v1/request', {
        mediaType: 'manga',
        mediaId: mangaId,
        mangaScope: body,
      });
      revalidate();
      toast(messages.requestSuccess);
      onComplete?.(
        response.data?.status === MediaRequestStatus.APPROVED
          ? MediaStatus.PROCESSING
          : MediaStatus.PENDING
      );
    } catch (caught) {
      setSubmitError(errorMessage(caught, messages.requestError));
    } finally {
      setIsUpdating(false);
    }
  };

  const saveRequest = async () => {
    if (!editRequest) {
      return;
    }
    if (!body) {
      setShowErrors(true);
      return;
    }
    setIsUpdating(true);
    setSubmitError(undefined);
    try {
      await axios.put(`/api/v1/request/${editRequest.id}`, {
        mangaScope: body,
      });
      revalidate();
      toast(messages.requestUpdated);
      onComplete?.(MediaStatus.PENDING);
    } catch (caught) {
      setSubmitError(errorMessage(caught, messages.saveError));
    } finally {
      setIsUpdating(false);
    }
  };

  const cancelRequest = async () => {
    if (!editRequest) {
      return;
    }
    setIsUpdating(true);
    setSubmitError(undefined);
    try {
      await axios.delete(`/api/v1/request/${editRequest.id}`);
      revalidate();
      toast(messages.requestCanceled);
      onComplete?.(MediaStatus.UNKNOWN);
    } catch (caught) {
      setSubmitError(errorMessage(caught, messages.cancelError));
    } finally {
      setIsUpdating(false);
    }
  };

  const changeDraft = (next: MangaScopeDraft) => {
    setDraft(next);
    setSubmitError(undefined);
  };

  const summary = (rows: [MessageDescriptor, ReactNode][]) => (
    <div className="app-card-inset refreshed-inset-surface detail-summary-card grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-3 sm:grid-cols-[80px_minmax(0,1fr)]">
      <div className="detail-card-poster relative overflow-hidden rounded-lg ring-1 ring-gray-600">
        <CachedImage
          type="tmdb"
          src={poster}
          alt=""
          fill
          sizes="(min-width: 640px) 80px, 64px"
          className="object-cover"
        />
      </div>
      <div className="flex min-w-0 flex-col">
        <h3 className="detail-summary-title truncate text-lg leading-5 font-semibold text-white">
          {title}
          {data?.startYear ? ` (${data.startYear})` : ''}
        </h3>
        <dl className="media-detail-rows refreshed-detail-text detail-card-heading-spacing grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3 text-xs">
          {rows.map(([label, value]) => (
            <div className="contents" key={label.id}>
              <dt className="font-medium text-gray-100">
                {intl.formatMessage(label)}:
              </dt>
              <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );

  const alerts = (
    <>
      {loadError && <Alert title={loadError} type="warning" />}
      {submitError && <Alert title={submitError} type="warning" />}
    </>
  );

  if (editRequest && request) {
    const isOwner = request.requestedBy?.id === user?.id;
    const isPending = request.status === MediaRequestStatus.PENDING;
    const canEdit =
      isPending &&
      (hasPermission(Permission.MANAGE_REQUESTS) ||
        (isOwner && hasPermission(Permission.REQUEST_ADVANCED)));
    const ownerCancelOnly = isPending && isOwner && !canEdit;
    const statusLabel = requestStatusLabels[request.status];
    const scopeReady =
      requestData !== undefined ||
      requestError !== undefined ||
      editRequest.mangaScope !== undefined;

    return (
      <Modal
        loading={(!data && !error) || !scopeReady}
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(
          isPending ? messages.pendingRequest : messages.mangaRequest
        )}
        subTitle={data?.title}
        onOk={
          canEdit
            ? () => void saveRequest()
            : ownerCancelOnly
              ? () => void cancelRequest()
              : undefined
        }
        okText={
          canEdit
            ? intl.formatMessage(
                isUpdating ? globalMessages.saving : globalMessages.save
              )
            : intl.formatMessage(messages.cancelRequest)
        }
        okButtonType={canEdit ? 'primary' : 'danger'}
        okButtonProps={canEdit ? undefined : { buttonIcon: 'cancel' }}
        okDisabled={isUpdating}
        onSecondary={canEdit ? () => void cancelRequest() : undefined}
        secondaryText={
          canEdit ? intl.formatMessage(messages.cancelRequest) : undefined
        }
        secondaryButtonType="danger"
        secondaryButtonProps={{ buttonIcon: 'cancel' }}
        secondaryDisabled={isUpdating}
        cancelText={intl.formatMessage(globalMessages.close)}
        cancelButtonType="danger"
        alignTop
        actionButtonSize="standard"
        dialogClass="app-card-main request-modal-site-surface sm:max-w-5xl"
      >
        {alerts}
        <RequestMediaCard artwork={artwork} artworkType="tmdb">
          {summary([
            [
              globalMessages.status,
              isAwaitingMangaSource(request) ? (
                <MangaWaitingStatus
                  showHint={hasPermission(Permission.MANAGE_REQUESTS)}
                />
              ) : statusLabel ? (
                intl.formatMessage(statusLabel)
              ) : null,
            ],
            [mangaScopeMessages.chapters, formatMangaScope(intl, scopeSummary)],
          ])}
          {isPending && (
            <div className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
              {isOwner
                ? intl.formatMessage(messages.pendingApproval)
                : intl.formatMessage(messages.requestFrom, {
                    username: request.requestedBy?.displayName,
                  })}
            </div>
          )}
          {canEdit && (
            <MangaScopeFields
              draft={formDraft}
              errors={errors}
              showErrors={showErrors}
              disabled={isUpdating}
              onChange={changeDraft}
            />
          )}
        </RequestMediaCard>
      </Modal>
    );
  }

  const isAvailable = data?.mediaInfo?.status === MediaStatus.AVAILABLE;
  const isBlocklisted = data?.mediaInfo?.status === MediaStatus.BLOCKLISTED;
  const isRequested = !!data?.mediaInfo?.requests?.some(
    (existing) =>
      existing.status === MediaRequestStatus.PENDING ||
      existing.status === MediaRequestStatus.APPROVED
  );
  const requestDisabled =
    isUpdating ||
    !data ||
    isAvailable ||
    isBlocklisted ||
    isRequested ||
    !!quota?.manga?.restricted;
  const hasAutoApprove = hasAutoApprovePermission(
    user?.permissions ?? 0,
    'manga'
  );

  return (
    <Modal
      loading={(!data && !error) || (!!user && !quota && !quotaError)}
      backgroundClickable
      onCancel={onCancel}
      hideActions
      alignTop
      title={intl.formatMessage(messages.requestManga)}
      dialogClass="app-card-main request-modal-site-surface sm:max-w-5xl"
    >
      {(quota?.manga?.limit ?? 0) > 0 && (
        <QuotaDisplay mediaType="manga" quota={quota?.manga} />
      )}
      {alerts}
      <RequestMediaCard artwork={artwork} artworkType="tmdb">
        {data &&
          summary([
            [
              globalMessages.status,
              intl.formatMessage(
                isAvailable
                  ? globalMessages.available
                  : isBlocklisted
                    ? globalMessages.blocklisted
                    : isRequested
                      ? globalMessages.requested
                      : messages.readyToRequest
              ),
            ],
            [
              messages.approval,
              <RequestFooterStatus
                key="approval"
                available={isAvailable}
                requested={isRequested}
                hasAutoApprove={hasAutoApprove}
              />,
            ],
          ])}
        {data && (
          <MangaScopeFields
            draft={formDraft}
            errors={errors}
            showErrors={showErrors}
            disabled={isUpdating}
            onChange={changeDraft}
          />
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="modal-cancel-button"
            className="app-button app-button-danger button-standard"
          >
            <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(globalMessages.cancel)}
          </button>
          {data && (
            <button
              type="button"
              onClick={() => void sendRequest()}
              data-testid="modal-ok-button"
              disabled={requestDisabled}
              className="app-button app-button-success button-standard"
            >
              <ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {intl.formatMessage(
                isUpdating ? globalMessages.requesting : globalMessages.request
              )}
            </button>
          )}
        </div>
      </RequestMediaCard>
    </Modal>
  );
};

export default MangaRequestModal;
