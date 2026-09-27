import {
  CompactSelect,
  FilterResetButton,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import MusicReleaseTypeSelect from '@app/components/Discover/FilterPanel/MusicReleaseTypeSelect';
import defineMessages from '@app/utils/defineMessages';
import {
  EMPTY_MUSIC_COLLECTION_FILTERS,
  musicCollectionFilterOptions,
  type MusicCollectionFilters,
} from '@app/utils/musicCollectionFilters';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MusicCollectionFilters', {
  clear: 'Clear Filters',
  genre: 'Genres',
  year: 'Release Year',
  any: 'Any',
  unknown: 'Unknown',
  label: 'Collection filters',
  loading: 'Loading...',
  selection: 'Selection {selected}/{total}',
});
export default function MusicCollectionFilterRow({
  parts,
  filters,
  onChange,
  loading,
  selectedCount,
  totalCount,
}: {
  parts: CuratedCollectionMember[];
  filters: MusicCollectionFilters;
  onChange: (filters: MusicCollectionFilters) => void;
  loading: boolean;
  selectedCount: number;
  totalCount: number;
}) {
  const intl = useIntl();
  const options = musicCollectionFilterOptions(parts);
  const any = { value: '', label: intl.formatMessage(messages.any) };
  const inactive = !Object.values(filters).some(Boolean);
  return (
    <div
      className="music-collection-filter-row"
      role="group"
      aria-label={intl.formatMessage(messages.label)}
    >
      <FilterResetButton
        label={intl.formatMessage(messages.clear)}
        selected={inactive}
        onClick={() => onChange({ ...EMPTY_MUSIC_COLLECTION_FILTERS })}
      />
      <MusicReleaseTypeSelect
        value={filters.releaseType}
        onChange={(releaseType) => onChange({ ...filters, releaseType })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.genre)}
        value={filters.genre}
        options={[any, ...options.genres]}
        onChange={(genre) => onChange({ ...filters, genre })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.year)}
        value={filters.year}
        options={[
          any,
          ...options.years,
          ...(options.unknownYear
            ? [
                {
                  value: 'unknown',
                  label: intl.formatMessage(messages.unknown),
                },
              ]
            : []),
        ]}
        onChange={(year) => onChange({ ...filters, year })}
      />
      <span
        className="music-collection-load-status"
        aria-live="polite"
        aria-busy={loading}
      >
        {loading ? (
          <>
            {intl.formatMessage(messages.loading)}
            <ArrowPathIcon
              className="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
          </>
        ) : (
          intl.formatMessage(messages.selection, {
            selected: selectedCount,
            total: totalCount,
          })
        )}
      </span>
    </div>
  );
}
