import FormatRequestControl from '@app/components/Common/FormatRequestControl';
import defineMessages from '@app/utils/defineMessages';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaDetails.MediaQualitySelect', {
  selectQuality: 'Select Quality',
  unavailable: 'This quality is not available in your library.',
  select: 'Use {quality} for playback.',
  report: 'Report an issue with the {quality} version.',
  request: 'Request the {quality} version.',
});

interface MediaQualitySelectProps<Quality extends string> {
  value: Quality | undefined;
  options: { label: string; value: Quality; disabled?: boolean }[];
  onChange: (quality: Quality) => void;
  className?: string;
  label?: string;
  purpose?: 'playback' | 'issue' | 'request';
  autoSelectAvailable?: boolean;
}

const MediaQualitySelect = <Quality extends string>({
  value,
  options,
  onChange,
  className,
  label,
  purpose = 'playback',
  autoSelectAvailable = true,
}: MediaQualitySelectProps<Quality>) => {
  const intl = useIntl();
  const firstAvailable = options.find((option) => !option.disabled)?.value;
  const selectedAvailable = options.some(
    (option) => option.value === value && !option.disabled
  );
  useEffect(() => {
    if (
      autoSelectAvailable &&
      !selectedAvailable &&
      firstAvailable !== undefined
    ) {
      onChange(firstAvailable);
    }
  }, [autoSelectAvailable, selectedAvailable, firstAvailable, onChange]);

  return (
    <FormatRequestControl
      label={label ?? intl.formatMessage(messages.selectQuality)}
      icon={<AdjustmentsHorizontalIcon aria-hidden="true" />}
      className={`${firstAvailable === undefined ? 'media-quality-unavailable' : ''} ${className ?? ''}`}
      options={options.map((option) => ({
        id: option.value,
        label: option.label,
        selected: !option.disabled && option.value === value,
        disabled: option.disabled,
        disabledReason: intl.formatMessage(messages.unavailable),
        description: intl.formatMessage(
          purpose === 'issue'
            ? messages.report
            : purpose === 'request'
              ? messages.request
              : messages.select,
          {
            quality: option.label,
          }
        ),
        onClick: () => {
          if (!option.disabled) onChange(option.value);
        },
      }))}
    />
  );
};

export default MediaQualitySelect;
