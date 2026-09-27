import Tooltip from '@app/components/Common/Tooltip';
import { getFilterToggleButtonClass } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import useCardTextVisibility from '@app/hooks/useCardTextVisibility';
import defineMessages from '@app/utils/defineMessages';
import { Bars3BottomLeftIcon } from '@heroicons/react/24/outline';
import type { UserSettingsCardTextResponse } from '@server/interfaces/api/userSettingsInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.CardTextVisibilityToggle', {
  titleView: 'Title View',
  showText: 'Always show titles',
  hideText: 'Only show titles on hover',
});

interface CardTextVisibilityToggleProps {
  mediaType:
    keyof UserSettingsCardTextResponse | (keyof UserSettingsCardTextResponse)[];
  className?: string;
}

const CardTextVisibilityToggle = ({
  mediaType,
  className = '',
}: CardTextVisibilityToggleProps) => {
  const intl = useIntl();
  const { visibility, setVisibility } = useCardTextVisibility();
  const mediaTypes = Array.isArray(mediaType) ? mediaType : [mediaType];
  const isAlwaysVisible = mediaTypes.every(
    (currentMediaType) => visibility[currentMediaType] === 'always'
  );
  const label = intl.formatMessage(
    isAlwaysVisible ? messages.hideText : messages.showText
  );

  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`${getFilterToggleButtonClass(isAlwaysVisible)} ${className}`}
        aria-pressed={isAlwaysVisible}
        aria-label={`${intl.formatMessage(messages.titleView)}: ${label}`}
        onClick={(e) => {
          e.preventDefault();
          void (async () => {
            const nextVisibility = isAlwaysVisible ? 'hover' : 'always';

            for (const currentMediaType of mediaTypes) {
              await setVisibility(currentMediaType, nextVisibility);
            }
          })();
        }}
      >
        <Bars3BottomLeftIcon className="h-4 w-4" aria-hidden="true" />
        {intl.formatMessage(messages.titleView)}
      </button>
    </Tooltip>
  );
};

export default CardTextVisibilityToggle;
