import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { TrashIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

// Keep the existing translation IDs shared by Request Status and Manage.
export const requestActionMessageText = {
  delete: 'Delete',
  deleting: 'Deleting…',
  deleteTooltip: 'Delete this request and its status history.',
  deleteTitle: 'Delete Request Entry?',
  deleteDescription:
    'Seerr will cancel any active work it can identify, clean up temporary request records, and permanently remove this entry and its history.',
  deleteFailed: 'Unable to delete this request entry.',
  deleteSuccess: 'Request entry deleted.',
  remove: 'Delete From Library',
  removing: 'Deleting…',
  removeTooltip: 'The media and the library entry will both be deleted.',
  removeUnavailableTooltip: 'No linked library item is available to delete.',
  removeTitle: 'Permanently Delete {title} from {service}?',
  removeDescription:
    'This will permanently delete its media files and remove its library entry from {service}. This action cannot be undone from Seerr. Other quality versions remain. When the last movie or series copy is confirmed gone, library reconciliation also removes its requests and issues, but preserves blocklists and watchlists.',
  removeFailed: 'Unable to delete this item from its library service.',
  removeSuccess: 'Item deleted from its library service.',
};

export const requestActionMessages = defineMessages(
  'components.RequestStatus',
  requestActionMessageText
);

export const deleteRequestStatus = (requestId: number) =>
  axios.delete(`/api/v1/request/${requestId}/status`);

export interface LibraryRemovalTarget {
  mediaId: number;
  is4k: boolean;
  format?: 'ebook' | 'audiobook' | 'both';
}

export const deleteLibraryMedia = (target: LibraryRemovalTarget) => {
  const params = new URLSearchParams({ is4k: String(target.is4k) });
  if (target.format) params.set('format', target.format);
  return axios.delete(`/api/v1/media/${target.mediaId}/file?${params}`);
};

export const RequestActionButton = ({
  action,
  busy = false,
  disabled = false,
  unavailable = false,
  label,
  tooltip,
  disabledReason,
  onClick,
}: {
  action: 'delete' | 'remove';
  busy?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  label?: string;
  tooltip?: string;
  disabledReason?: string;
  onClick: () => void;
}) => {
  const intl = useIntl();
  return (
    <Tooltip
      content={
        busy
          ? intl.formatMessage(requestActionMessages.deleting)
          : (disabled && disabledReason) ||
            tooltip ||
            intl.formatMessage(
              action === 'delete'
                ? requestActionMessages.deleteTooltip
                : unavailable
                  ? requestActionMessages.removeUnavailableTooltip
                  : requestActionMessages.removeTooltip
            )
      }
    >
      <span>
        <Button
          type="button"
          buttonType="danger"
          buttonSize="standard"
          disabled={disabled || busy}
          onClick={onClick}
        >
          <TrashIcon aria-hidden="true" />
          {(!busy && label) ||
            intl.formatMessage(
              busy
                ? requestActionMessages.deleting
                : requestActionMessages[action]
            )}
        </Button>
      </span>
    </Tooltip>
  );
};

export const RequestActionConfirmation = ({
  action,
  title,
  service,
  busy,
  disabled = false,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
  heading,
  explanation,
}: {
  action: 'delete' | 'remove';
  title?: string;
  service?: string;
  busy: boolean;
  disabled?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  heading?: string;
  explanation?: string;
}) => {
  const intl = useIntl();
  return (
    <Modal
      title={
        heading ??
        intl.formatMessage(
          action === 'delete'
            ? requestActionMessages.deleteTitle
            : requestActionMessages.removeTitle,
          { title, service }
        )
      }
      okText={confirmLabel ?? intl.formatMessage(requestActionMessages[action])}
      okButtonType="danger"
      okButtonProps={{ buttonIcon: 'delete' }}
      cancelButtonType="success"
      loading={busy}
      okDisabled={disabled || busy}
      backgroundClickable={!busy}
      onOk={onConfirm}
      onCancel={busy ? undefined : onCancel}
      actionButtonSize="standard"
      dialogClass="app-card-main request-modal-site-surface refreshed-detail-text request-action-dialog"
    >
      <div className="card-stack">
        {children}
        <p className="app-card-inset refreshed-inset-surface app-card-sub request-action-explanation">
          {explanation ??
            intl.formatMessage(
              action === 'delete'
                ? requestActionMessages.deleteDescription
                : requestActionMessages.removeDescription,
              { service }
            )}
        </p>
      </div>
    </Modal>
  );
};
