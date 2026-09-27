import {
  CompactRatingSelect,
  CompactSelect,
  FilterResetButton,
  type CompactSelectOption,
  type RatingOption,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import defineMessages from '@app/utils/defineMessages';
import type { TmdbGenre } from '@server/api/themoviedb/interfaces';
import type { Language } from '@server/lib/settings';
import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import type { MovieResult } from '@server/models/Search';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal.CollectionFilters', {
  clear: 'Clear Filters',
  status: 'Status',
  releaseDate: 'Release Date',
  genres: 'Genres',
  rating: 'Rating',
  language: 'Language',
  any: 'Any',
  returningSeries: 'Returning Series',
  planned: 'Planned',
  inProduction: 'In Production',
  ended: 'Ended',
  canceled: 'Canceled',
  pilot: 'Pilot',
});

export type VideoCollectionFilters = {
  status: string;
  year: string;
  genre: string;
  rating: string;
  language: string;
};

export const EMPTY_VIDEO_COLLECTION_FILTERS: VideoCollectionFilters = {
  status: '',
  year: '',
  genre: '',
  rating: '',
  language: '',
};

export const matchesVideoCollectionFilters = (
  part: MovieResult | CuratedCollectionMember,
  filters: VideoCollectionFilters,
  kind: 'movie' | 'tv'
): boolean => {
  const year = part.releaseDate?.slice(0, 4);
  return (
    (kind !== 'tv' ||
      !filters.status ||
      ('status' in part && part.status === filters.status)) &&
    (!filters.year ||
      (filters.year === 'before-1970'
        ? !!year && Number(year) < 1970
        : year === filters.year)) &&
    (!filters.genre ||
      part.genreIds?.includes(Number(filters.genre)) === true) &&
    (!filters.rating || (part.voteAverage ?? 0) >= Number(filters.rating)) &&
    (!filters.language || part.originalLanguage === filters.language)
  );
};

export default function VideoCollectionRequestFilters({
  kind,
  filters,
  onChange,
}: {
  kind: 'movie' | 'tv';
  filters: VideoCollectionFilters;
  onChange: (filters: VideoCollectionFilters) => void;
}) {
  const intl = useIntl();
  const { data: availableGenres } = useSWR<TmdbGenre[]>(
    `/api/v1/genres/${kind}`
  );
  const { data: languages } = useSWR<Language[]>('/api/v1/languages');
  const any: CompactSelectOption = {
    label: intl.formatMessage(messages.any),
    value: '',
  };
  const currentYear = new Date().getFullYear();
  const yearOptions: CompactSelectOption[] = [
    any,
    ...Array.from({ length: currentYear - 1969 }, (_, index) => {
      const year = String(currentYear - index);
      return { label: year, value: year };
    }),
    { label: '<1970', value: 'before-1970' },
  ];
  const genreOptions: CompactSelectOption[] = [
    any,
    ...(availableGenres ?? []).map((genre) => ({
      label: genre.name,
      value: String(genre.id),
    })),
  ];
  const ratingOptions: RatingOption[] = [
    any,
    ...Array.from({ length: 10 }, (_, index) => {
      const score = index + 1;
      return {
        label: `${score.toFixed(1)}+`,
        value: String(score),
        score,
      };
    }),
  ];
  const languageOptions: CompactSelectOption[] = [
    any,
    ...(languages ?? [])
      .map((language) => ({
        label:
          intl.formatDisplayName(language.iso_639_1, {
            type: 'language',
            fallback: 'none',
          }) ?? language.english_name,
        value: language.iso_639_1,
      }))
      .sort((left, right) =>
        left.label.localeCompare(right.label, intl.locale, {
          sensitivity: 'base',
        })
      ),
  ];
  const update = (key: keyof VideoCollectionFilters, value: string) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="card-spacing-before flex flex-wrap items-center gap-2">
      <FilterResetButton
        label={intl.formatMessage(messages.clear)}
        selected={!Object.values(filters).some(Boolean)}
        onClick={() => onChange({ ...EMPTY_VIDEO_COLLECTION_FILTERS })}
      />
      {kind === 'tv' && (
        <CompactSelect
          label={intl.formatMessage(messages.status)}
          value={filters.status}
          options={[
            any,
            {
              label: intl.formatMessage(messages.returningSeries),
              value: 'Returning Series',
            },
            { label: intl.formatMessage(messages.planned), value: 'Planned' },
            {
              label: intl.formatMessage(messages.inProduction),
              value: 'In Production',
            },
            { label: intl.formatMessage(messages.ended), value: 'Ended' },
            {
              label: intl.formatMessage(messages.canceled),
              value: 'Canceled',
            },
            { label: intl.formatMessage(messages.pilot), value: 'Pilot' },
          ]}
          onChange={(value) => update('status', value)}
        />
      )}
      <CompactSelect
        label={intl.formatMessage(messages.releaseDate)}
        value={filters.year}
        options={yearOptions}
        onChange={(value) => update('year', value)}
      />
      <CompactSelect
        label={intl.formatMessage(messages.genres)}
        value={filters.genre}
        options={genreOptions}
        onChange={(value) => update('genre', value)}
      />
      <CompactRatingSelect
        label={intl.formatMessage(messages.rating)}
        value={filters.rating}
        options={ratingOptions}
        onChange={(value) => update('rating', value)}
      />
      <CompactSelect
        label={intl.formatMessage(messages.language)}
        value={filters.language}
        options={languageOptions}
        onChange={(value) => update('language', value)}
      />
    </div>
  );
}
