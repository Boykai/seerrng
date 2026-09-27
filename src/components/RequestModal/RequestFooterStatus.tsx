import Badge from '@app/components/Common/Badge';
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
      <Badge
        badgeType="success"
        className="h-[18px] items-center gap-1 !px-1.5 !text-[10px] !leading-none"
      >
        <CheckIcon className="h-3 w-3" aria-hidden="true" />
        {intl.formatMessage(globalMessages.available)}
      </Badge>
    );
  }

  if (requested) {
    return (
      <Badge
        badgeType="warning"
        className="h-[18px] items-center !px-1.5 !text-[10px] !leading-none"
      >
        {intl.formatMessage(messages.requested)}
      </Badge>
    );
  }

  return (
    <span
      className={`text-[11px] font-semibold ${
        hasAutoApprove ? 'text-emerald-300' : 'text-yellow-300'
      }`}
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
