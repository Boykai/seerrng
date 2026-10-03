import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import globalMessages from '@app/i18n/globalMessages';
import { useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

export interface MessageRetry {
  onClick: () => unknown | Promise<unknown>;
  tooltip: string;
  busy?: boolean;
}

interface PageErrorMessageProps {
  title: string;
  description?: ReactNode;
  severity?: 'error' | 'empty' | 'warning' | 'info';
  retry?: MessageRetry;
}

// Presentation belongs to the global message/card/button roles. The caller
// owns the data source, failure state and retry action, not a route-specific style.
const PageErrorMessage = ({
  title,
  description,
  severity = 'error',
  retry,
}: PageErrorMessageProps) => {
  const intl = useIntl();
  const retryActive = useRef(false);
  const [retryPending, setRetryPending] = useState(false);
  const busy = Boolean(retry?.busy || retryPending);
  const handleRetry = async () => {
    if (!retry || busy || retryActive.current) return;
    retryActive.current = true;
    setRetryPending(true);
    try {
      await retry.onClick();
    } catch {
      // The source owner exposes the actual fetch failure in its error state.
      // A failed recovery must not create an unhandled event-handler rejection.
    } finally {
      retryActive.current = false;
      setRetryPending(false);
    }
  };

  return (
    <div
      className="page-error-message"
      data-severity={severity}
      role={severity === 'error' ? 'alert' : 'status'}
    >
      <div>
        <h3 className="card-title">{title}</h3>
        {description && (
          <p className="page-error-message-detail">{description}</p>
        )}
      </div>
      {retry && (
        <Tooltip content={retry.tooltip}>
          <Button
            buttonType="warning"
            buttonSize="sm"
            buttonIcon="retry"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void handleRetry()}
          >
            {intl.formatMessage(globalMessages.retry)}
          </Button>
        </Tooltip>
      )}
    </div>
  );
};

export default PageErrorMessage;
