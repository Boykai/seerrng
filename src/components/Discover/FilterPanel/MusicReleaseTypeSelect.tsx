import { CompactSelect } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import defineMessages from '@app/utils/defineMessages';
import { MUSIC_RELEASE_TYPES } from '@server/constants/musicReleaseTypes';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MusicReleaseTypeSelect', {
  label: 'Release Type',
  any: 'Any',
});
export default function MusicReleaseTypeSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <CompactSelect
      className={className}
      label={intl.formatMessage(messages.label)}
      value={value}
      onChange={onChange}
      options={[
        { value: '', label: intl.formatMessage(messages.any) },
        ...MUSIC_RELEASE_TYPES.map((type) => ({ value: type, label: type })),
      ]}
    />
  );
}
