import {
  CompactRatingSelect,
  CompactSelect,
  type CompactSelectOption,
  type RatingOption,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import {
  BOOK_GENRES,
  BOOK_LANGUAGES,
} from '@app/components/Discover/FilterPanel/libraryFilterUtils';
import MusicArtistFilter from '@app/components/Discover/FilterPanel/MusicArtistSelector';
import MusicReleaseTypeSelect from '@app/components/Discover/FilterPanel/MusicReleaseTypeSelect';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.LibraryFilterFields', {
  keywordSearch: 'Keyword Search',
  search: 'Search',
  searchMusic: 'Search Music',
  authorSearch: 'Author Search',
  narratorSearch: 'Narrator Search',
  firstPublished: 'First Published',
  genres: 'Genres',
  rating: 'Rating',
  language: 'Language',
  releaseYear: 'Release Year',
  any: 'Any',
});

const musicGenres = [
  'Alternative',
  'Classical',
  'Country',
  'Electronic',
  'Hip-Hop',
  'Jazz',
  'Metal',
  'Pop',
  'Rock',
];

type BaseProps = {
  search: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void;
  setParam: (values: Record<string, string | undefined>) => void;
};

type BookProps = BaseProps & {
  mediaType: 'book';
  audiobook?: boolean;
  author: string;
  onAuthorChange: (value: string) => void;
  onAuthorSubmit: () => void;
  narrator?: string;
  onNarratorChange?: (value: string) => void;
  onNarratorSubmit?: () => void;
  firstPublishYear: string;
  subject: string;
  minRating: string;
  language: string;
};

type MusicProps = BaseProps & {
  mediaType: 'music';
  genre: string;
  releaseType: string;
  releaseYear: string;
};

type Props = BookProps | MusicProps;

const SearchControl = ({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  mediaType,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  mediaType: 'book' | 'music';
}) => (
  <form
    className={
      mediaType === 'music'
        ? 'discover-filter-control order-5 w-72 max-w-full flex-none'
        : 'discover-filter-control w-64 max-w-full flex-none'
    }
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <span
      className={
        'discover-filter-control-label' +
        (value.trim() ? ' discover-filter-control-label-active' : '')
      }
    >
      <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
      {label}
    </span>
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="min-w-0 flex-1 border-0 bg-transparent px-2 py-0 text-xs font-medium text-gray-200 placeholder:text-gray-500 focus:ring-0"
    />
  </form>
);

const LibraryFilterFields = (props: Props) => {
  const intl = useIntl();
  const currentYear = new Date().getFullYear();
  const yearOptions: CompactSelectOption[] = [
    {
      label: intl.formatMessage(messages.any),
      value: props.mediaType === 'music' ? 'any' : '',
    },
    ...Array.from({ length: currentYear - 1969 }, (_, index) => {
      const year = currentYear - index;
      return { label: year.toString(), value: year.toString() };
    }),
    { label: '<1970', value: 'before-1970' },
  ];

  if (props.mediaType === 'book') {
    const genreOptions: CompactSelectOption[] = [
      { label: intl.formatMessage(messages.any), value: '' },
      ...BOOK_GENRES.map(([value, label]) => ({ value, label })),
    ];
    const languageOptions: CompactSelectOption[] = [
      { label: intl.formatMessage(messages.any), value: '' },
      ...BOOK_LANGUAGES.map(([value, label]) => ({ value, label })),
    ];
    const ratingOptions: RatingOption[] = [
      { label: intl.formatMessage(messages.any), value: '' },
      ...Array.from({ length: 9 }, (_, index) => {
        const score = 1 + index * 0.5;
        return {
          label: score.toFixed(1) + '+',
          value: score.toFixed(1),
          score,
        };
      }),
    ];

    return (
      <>
        <SearchControl
          mediaType="book"
          label={intl.formatMessage(messages.keywordSearch)}
          placeholder={intl.formatMessage(messages.search)}
          value={props.search}
          onChange={props.onSearchChange}
          onSubmit={props.onSearchSubmit}
        />
        <CompactSelect
          label={intl.formatMessage(messages.firstPublished)}
          value={props.firstPublishYear}
          options={yearOptions}
          onChange={(value) =>
            props.setParam({ firstPublishYear: value || undefined })
          }
        />
        <CompactSelect
          label={intl.formatMessage(messages.genres)}
          value={props.subject}
          options={genreOptions}
          onChange={(value) => props.setParam({ subject: value || undefined })}
        />
        <SearchControl
          mediaType="book"
          label={intl.formatMessage(messages.authorSearch)}
          placeholder={intl.formatMessage(messages.search)}
          value={props.author}
          onChange={props.onAuthorChange}
          onSubmit={props.onAuthorSubmit}
        />
        {props.audiobook &&
          props.onNarratorChange &&
          props.onNarratorSubmit && (
            <SearchControl
              mediaType="book"
              label={intl.formatMessage(messages.narratorSearch)}
              placeholder={intl.formatMessage(messages.search)}
              value={props.narrator ?? ''}
              onChange={props.onNarratorChange}
              onSubmit={props.onNarratorSubmit}
            />
          )}
        <CompactRatingSelect
          label={intl.formatMessage(messages.rating)}
          value={props.minRating}
          options={ratingOptions}
          maxScore={5}
          onChange={(value) =>
            props.setParam({ minRating: value || undefined })
          }
        />
        <CompactSelect
          label={intl.formatMessage(messages.language)}
          value={props.language}
          options={languageOptions}
          onChange={(value) => props.setParam({ language: value || undefined })}
        />
      </>
    );
  }

  const genreOptions: CompactSelectOption[] = [
    { label: intl.formatMessage(messages.any), value: '' },
    ...musicGenres.map((value) => ({
      label: value,
      value: value.toLowerCase(),
    })),
  ];

  return (
    <>
      <MusicArtistFilter className="order-5" />
      <SearchControl
        mediaType="music"
        label={intl.formatMessage(messages.keywordSearch)}
        placeholder={intl.formatMessage(messages.searchMusic)}
        value={props.search}
        onChange={props.onSearchChange}
        onSubmit={props.onSearchSubmit}
      />
      <CompactSelect
        className="order-8"
        label={intl.formatMessage(messages.genres)}
        value={props.genre}
        options={genreOptions}
        onChange={(value) => props.setParam({ genre: value || undefined })}
      />
      <MusicReleaseTypeSelect
        className="order-7"
        value={props.releaseType}
        onChange={(value) =>
          props.setParam({ releaseType: value || undefined })
        }
      />
      <CompactSelect
        className="order-6"
        label={intl.formatMessage(messages.releaseYear)}
        value={props.releaseYear}
        options={yearOptions}
        onChange={(value) => {
          if (value === 'any') {
            props.setParam({
              primaryReleaseDateGte: undefined,
              primaryReleaseDateLte: undefined,
            });
          } else if (value === 'before-1970') {
            props.setParam({
              primaryReleaseDateGte: undefined,
              primaryReleaseDateLte: '1969-12-31',
            });
          } else {
            props.setParam({
              primaryReleaseDateGte: value + '-01-01',
              primaryReleaseDateLte: value + '-12-31',
            });
          }
        }}
      />
    </>
  );
};

export default LibraryFilterFields;
