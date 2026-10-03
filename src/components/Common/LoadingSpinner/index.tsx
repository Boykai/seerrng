import useSearchActivity from '@app/hooks/useSearchActivity';
import defineMessages from '@app/utils/defineMessages';
import { memo } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.PageStatus', {
  searching: 'Searching',
  loading: 'Loading',
});

const SpinnerIcon = memo(({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 38 38"
    xmlns="http://www.w3.org/2000/svg"
    stroke="currentColor"
  >
    <g fill="none" fillRule="evenodd">
      <g transform="translate(1 1)" strokeWidth="2">
        <circle strokeOpacity=".5" cx="18" cy="18" r="18" />
        <path d="M36 18c0-9.94-8.06-18-18-18">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 18 18"
            to="360 18 18"
            dur="1s"
            repeatCount="indefinite"
          />
        </path>
      </g>
    </g>
  </svg>
));

SpinnerIcon.displayName = 'SpinnerIcon';

export const PageStatus = memo(
  ({ active = false, label }: { active?: boolean; label?: string }) => {
    const searching = useSearchActivity();
    const intl = useIntl();
    if (!active && !searching) return null;

    // One display per title row; search activity wins while both are active.
    const statusLabel = searching
      ? intl.formatMessage(messages.searching)
      : (label ?? intl.formatMessage(messages.loading));
    return (
      <span className="page-status" role="status" aria-live="polite">
        <SpinnerIcon />
        <span>{statusLabel}</span>
      </span>
    );
  }
);

PageStatus.displayName = 'PageStatus';

export const SmallLoadingSpinner = memo(() => {
  return (
    <div className="inset-0 flex h-full w-full items-center justify-center text-gray-200">
      <SpinnerIcon className="h-10 w-10" />
    </div>
  );
});

SmallLoadingSpinner.displayName = 'SmallLoadingSpinner';

const LoadingSpinner = memo(() => {
  return (
    <div className="inset-0 flex h-64 items-center justify-center text-gray-200">
      <SpinnerIcon className="h-16 w-16" />
    </div>
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';

export default LoadingSpinner;
