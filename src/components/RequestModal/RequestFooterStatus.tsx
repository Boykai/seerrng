import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CheckIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.RequestFooterStatus', {
  approvedAutomatically: 'Automatically',
  approvalRequired: 'Approval Required',
  requested: 'Requested',
});

interface RequestFooterStatusProps {
  available: boolean;
  hasAutoApprove: boolean;
  requested?: boolean;
}

const RequestFooterStatus = ({
  available,
  hasAutoApprove,
  requested = false,
}: RequestFooterStatusProps) => {
  const intl = useIntl();

  if (available) {
    return (
      <span className="request-approval-text" data-approval-state="available">
        <CheckIcon aria-hidden="true" />
        {intl.formatMessage(globalMessages.available)}
      </span>
    );
  }

  if (requested) {
    return (
      <span className="request-approval-text" data-approval-state="pending">
        {intl.formatMessage(messages.requested)}
      </span>
    );
  }

  return (
    <span
      className="request-approval-text"
      data-approval-state={hasAutoApprove ? 'automatic' : 'required'}
    >
      {intl.formatMessage(
        hasAutoApprove
          ? messages.approvedAutomatically
          : messages.approvalRequired
      )}
    </span>
  );
};

export default RequestFooterStatus;
