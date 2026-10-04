import {
  CompactRatingSelect,
  CompactSelect,
  type CompactSelectOption,
  type RatingOption,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import { compactSelectComponents } from '@app/components/Selector';
import { useSearchActivityReporter } from '@app/hooks/useSearchActivity';
import defineMessages from '@app/utils/defineMessages';
import { useId } from 'react';
import { useIntl, type MessageDescriptor } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';
import {
  joinMangaFilterNames,
  MANGA_COUNTRIES,
  MANGA_FORMATS,
  MANGA_SOURCES,
  MANGA_STATUSES,
  MAX_MANGA_FILTER_NAMES,
  splitMangaFilterNames,
  type MangaFilterKey,
  type MangaFilterParams,
  type MangaFilterUpdate,
  type MangaNameFilter,
} from './mangaFilterParams';

const messages = defineMessages(
  'components.Discover.DiscoverManga.MangaFilters',
  {
    any: 'Any',
    genres: 'Genres',
    excludeGenres: 'Exclude Genres',
    tags: 'Tags',
    excludeTags: 'Exclude Tags',
    nameSummary: '{name} +{count}',
    noMatches: 'No matching names',
    listsUnavailable: 'Genre and tag lists are unavailable right now.',
    format: 'Format',
    status: 'Status',
    country: 'Country',
    source: 'Source Material',
    startYear: 'Start Year',
    score: 'AniList Score',
    chapters: 'Chapters',
    volumes: 'Volumes',
    upTo: 'Up to {count}',
    atLeast: '{count}+',
    currentRange: 'Current: {minimum}–{maximum}',
    formatManga: 'Manga',
    formatOneShot: 'One Shot',
    formatNovel: 'Novel',
    statusFinished: 'Finished',
    statusReleasing: 'Releasing',
    statusNotYetReleased: 'Not Yet Released',
    statusCancelled: 'Cancelled',
    statusHiatus: 'Hiatus',
    sourceOriginal: 'Original',
    sourceManga: 'Manga',
    sourceLightNovel: 'Light Novel',
    sourceWebNovel: 'Web Novel',
    sourceNovel: 'Novel',
    sourceVisualNovel: 'Visual Novel',
    sourceVideoGame: 'Video Game',
    sourceGame: 'Game',
    sourceAnime: 'Anime',
    sourceLiveAction: 'Live Action',
    sourceComic: 'Comic',
    sourceDoujinshi: 'Doujinshi',
    sourcePictureBook: 'Picture Book',
    sourceMultimediaProject: 'Multimedia Project',
    sourceOther: 'Other',
  }
);

const formatLabels: Record<(typeof MANGA_FORMATS)[number], MessageDescriptor> =
  {
    MANGA: messages.formatManga,
    ONE_SHOT: messages.formatOneShot,
    NOVEL: messages.formatNovel,
  };
const statusLabels: Record<(typeof MANGA_STATUSES)[number], MessageDescriptor> =
  {
    FINISHED: messages.statusFinished,
    RELEASING: messages.statusReleasing,
    NOT_YET_RELEASED: messages.statusNotYetReleased,
    CANCELLED: messages.statusCancelled,
    HIATUS: messages.statusHiatus,
  };
const sourceLabels: Record<(typeof MANGA_SOURCES)[number], MessageDescriptor> =
  {
    ORIGINAL: messages.sourceOriginal,
    MANGA: messages.sourceManga,
    LIGHT_NOVEL: messages.sourceLightNovel,
    WEB_NOVEL: messages.sourceWebNovel,
    NOVEL: messages.sourceNovel,
    VISUAL_NOVEL: messages.sourceVisualNovel,
    VIDEO_GAME: messages.sourceVideoGame,
    GAME: messages.sourceGame,
    ANIME: messages.sourceAnime,
    LIVE_ACTION: messages.sourceLiveAction,
    COMIC: messages.sourceComic,
    DOUJINSHI: messages.sourceDoujinshi,
    PICTURE_BOOK: messages.sourcePictureBook,
    MULTIMEDIA_PROJECT: messages.sourceMultimediaProject,
    OTHER: messages.sourceOther,
  };
// Formats every content setting allows, shown until AniList's lists load.
const DEFAULT_FORMATS: readonly string[] = ['MANGA', 'ONE_SHOT'];

interface MangaFilterCatalog {
  genres: string[];
  tags: string[];
  formats: string[];
}

type NameOption = { label: string; value: string };
const toNameOption = (name: string): NameOption => ({
  label: name,
  value: name,
});

const MangaNamePicker = ({
  label,
  names,
  choices,
  unavailable,
  onChange,
}: {
  label: string;
  names: string[];
  choices: readonly string[];
  unavailable: boolean;
  onChange: (names: string[]) => void;
}) => {
  const intl = useIntl();
  const id = useId();
  const selected = new Set(names);
  // Names already chosen stay listed, so they can be removed even when
  // AniList's lists are unavailable.
  const options = [
    ...choices,
    ...names.filter((name) => !choices.includes(name)),
  ].map(toNameOption);
  const summary =
    names.length === 0
      ? intl.formatMessage(messages.any)
      : names.length === 1
        ? names[0]
        : intl.formatMessage(messages.nameSummary, {
            name: names[0],
            count: names.length - 1,
          });

  return (
    <div className="discover-filter-control">
      <span
        className={`discover-filter-control-label ${
          names.length ? 'discover-filter-control-label-active' : ''
        }`}
      >
        {label}
      </span>
      <Select<NameOption, true>
        inputId={`${id}-input`}
        instanceId={id}
        aria-label={label}
        className="react-select-container discover-compact-select"
        classNamePrefix="react-select"
        unstyled
        components={compactSelectComponents}
        isMulti
        controlShouldRenderValue={false}
        hideSelectedOptions={false}
        closeMenuOnSelect={false}
        options={options}
        value={names.map(toNameOption)}
        isOptionDisabled={(option) =>
          names.length >= MAX_MANGA_FILTER_NAMES && !selected.has(option.value)
        }
        placeholder={summary}
        noOptionsMessage={() =>
          intl.formatMessage(
            unavailable ? messages.listsUnavailable : messages.noMatches
          )
        }
        onChange={(next) => onChange(next.map((option) => option.value))}
      />
    </div>
  );
};

const NAME_PICKERS = [
  { key: 'genres', opposite: 'excludeGenres', list: 'genres' },
  { key: 'excludeGenres', opposite: 'genres', list: 'genres' },
  { key: 'tags', opposite: 'excludeTags', list: 'tags' },
  { key: 'excludeTags', opposite: 'tags', list: 'tags' },
] as const satisfies readonly {
  key: MangaNameFilter & keyof typeof messages;
  opposite: MangaNameFilter;
  list: 'genres' | 'tags';
}[];

interface MangaFiltersProps {
  filters: MangaFilterParams;
  onChange: (values: MangaFilterUpdate) => void;
}

// AniList filters for the manga Discover page. AniList's genre and tag names
// load only while these controls are shown.
const MangaFilters = ({ filters, onChange }: MangaFiltersProps) => {
  const intl = useIntl();
  const { data: catalog, error } = useSWR<MangaFilterCatalog>(
    '/api/v1/discover/manga/filters'
  );
  useSearchActivityReporter(!catalog && !error, 'manga-filter-options');
  const any = intl.formatMessage(messages.any);

  const setNames = (
    key: MangaNameFilter,
    opposite: MangaNameFilter,
    names: string[]
  ) =>
    // A name can be included or excluded, not both.
    onChange({
      [key]: joinMangaFilterNames(names),
      [opposite]: joinMangaFilterNames(
        splitMangaFilterNames(filters[opposite]).filter(
          (name) => !names.includes(name)
        )
      ),
    });

  const listOptions = <T extends string>(
    values: readonly T[],
    label: (value: T) => string
  ): CompactSelectOption[] => [
    { label: any, value: '' },
    ...values.map((value) => ({ label: label(value), value })),
  ];
  const offeredFormats = catalog?.formats ?? DEFAULT_FORMATS;
  const formatOptions = listOptions(
    MANGA_FORMATS.filter(
      (format) => offeredFormats.includes(format) || format === filters.format
    ),
    (format) => intl.formatMessage(formatLabels[format])
  );

  const range = (
    minKey: MangaFilterKey,
    maxKey: MangaFilterKey,
    presets: RatingOption[]
  ) => {
    const minimum = filters[minKey];
    const maximum = filters[maxKey];
    const preset = presets.find(
      (option) => option.gte === minimum && option.lte === maximum
    );
    const options = preset
      ? presets
      : [
          ...presets,
          {
            label: intl.formatMessage(messages.currentRange, {
              minimum: minimum ?? any,
              maximum: maximum ?? any,
            }),
            value: 'current',
            gte: minimum,
            lte: maximum,
          },
        ];
    return {
      value: preset?.value ?? 'current',
      options,
      onChange: (value: string) => {
        const choice = options.find((option) => option.value === value);
        onChange({ [minKey]: choice?.gte, [maxKey]: choice?.lte });
      },
    };
  };
  const currentYear = new Date().getFullYear();
  const yearPresets: RatingOption[] = [
    { label: any, value: 'any' },
    ...Array.from({ length: currentYear - 1969 }, (_, index) => {
      const year = String(currentYear - index);
      return { label: year, value: year, gte: year, lte: year };
    }),
    { label: '<1970', value: 'before-1970', lte: '1969' },
  ];
  const scorePresets: RatingOption[] = [
    { label: any, value: 'any' },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => ({
      label: `${step * 10}+`,
      value: `${step * 10}-plus`,
      gte: String(step * 10),
      score: step,
    })),
  ];
  const countPresets = (
    upTo: readonly number[],
    atLeast: readonly number[]
  ): RatingOption[] => [
    { label: any, value: 'any' },
    ...upTo.map((count) => ({
      label: intl.formatMessage(messages.upTo, { count }),
      value: `up-to-${count}`,
      lte: String(count),
    })),
    ...atLeast.map((count) => ({
      label: intl.formatMessage(messages.atLeast, { count }),
      value: `${count}-plus`,
      gte: String(count),
    })),
  ];

  return (
    <>
      {NAME_PICKERS.map((picker) => (
        <MangaNamePicker
          key={picker.key}
          label={intl.formatMessage(messages[picker.key])}
          names={splitMangaFilterNames(filters[picker.key])}
          choices={catalog?.[picker.list] ?? []}
          unavailable={Boolean(error)}
          onChange={(names) => setNames(picker.key, picker.opposite, names)}
        />
      ))}
      <CompactSelect
        label={intl.formatMessage(messages.format)}
        value={filters.format ?? ''}
        options={formatOptions}
        onChange={(value) => onChange({ format: value || undefined })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.status)}
        value={filters.status ?? ''}
        options={listOptions(MANGA_STATUSES, (status) =>
          intl.formatMessage(statusLabels[status])
        )}
        onChange={(value) => onChange({ status: value || undefined })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.country)}
        value={filters.countryOfOrigin ?? ''}
        options={listOptions(
          MANGA_COUNTRIES,
          (country) =>
            intl.formatDisplayName(country, { type: 'region' }) ?? country
        )}
        onChange={(value) => onChange({ countryOfOrigin: value || undefined })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.source)}
        value={filters.source ?? ''}
        options={listOptions(MANGA_SOURCES, (source) =>
          intl.formatMessage(sourceLabels[source])
        )}
        onChange={(value) => onChange({ source: value || undefined })}
      />
      <CompactSelect
        label={intl.formatMessage(messages.startYear)}
        {...range('minStartYear', 'maxStartYear', yearPresets)}
      />
      <CompactRatingSelect
        label={intl.formatMessage(messages.score)}
        {...range('minScore', 'maxScore', scorePresets)}
      />
      <CompactSelect
        label={intl.formatMessage(messages.chapters)}
        {...range(
          'minChapters',
          'maxChapters',
          countPresets([10, 50], [50, 100, 200, 500])
        )}
      />
      <CompactSelect
        label={intl.formatMessage(messages.volumes)}
        {...range(
          'minVolumes',
          'maxVolumes',
          countPresets([1, 5], [5, 10, 20, 50])
        )}
      />
    </>
  );
};

export default MangaFilters;
