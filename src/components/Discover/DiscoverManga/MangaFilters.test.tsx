import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import MangaFilters from './MangaFilters';
import type { MangaFilterParams } from './mangaFilterParams';

type Option = {
  label: string;
  value: string;
  gte?: string;
  lte?: string;
  score?: number;
};
type SelectProps = {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  rating?: boolean;
};
type PickerProps = {
  'aria-label': string;
  className: string;
  isMulti: boolean;
  controlShouldRenderValue: boolean;
  options: { value: string }[];
  value: { value: string }[];
  placeholder: string;
  isOptionDisabled: (option: { value: string }) => boolean;
  noOptionsMessage: () => string;
  onChange: (options: { value: string }[]) => void;
};

const state = vi.hoisted(() => ({
  swrKeys: [] as unknown[],
  swr: {} as { data?: unknown; error?: unknown },
  activity: [] as unknown[][],
  pickers: new Map<string, unknown>(),
  selects: new Map<string, unknown>(),
}));
vi.mock('swr', () => ({
  default: (key: unknown) => {
    state.swrKeys.push(key);
    return state.swr;
  },
}));
vi.mock('react-select', () => ({
  default: (props: { 'aria-label': string }) => {
    state.pickers.set(props['aria-label'], props);
    return null;
  },
}));
vi.mock('@app/components/Selector', () => ({ compactSelectComponents: {} }));
vi.mock('@app/hooks/useSearchActivity', () => ({
  useSearchActivityReporter: (...args: unknown[]) => {
    state.activity.push(args);
  },
}));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  CompactSelect: (props: SelectProps) => {
    state.selects.set(props.label, props);
    return null;
  },
  CompactRatingSelect: (props: SelectProps) => {
    state.selects.set(props.label, { ...props, rating: true });
    return null;
  },
}));

const catalog = {
  genres: ['Action', 'Drama', 'Horror'],
  tags: ['Isekai', 'Time Skip'],
  formats: ['MANGA', 'ONE_SHOT'],
};
const onChange = vi.fn();

beforeEach(() => {
  state.swrKeys = [];
  state.swr = { data: catalog };
  state.activity = [];
  state.pickers.clear();
  state.selects.clear();
  onChange.mockReset();
});

const render = (filters: MangaFilterParams = {}) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <MangaFilters filters={filters} onChange={onChange} />
    </IntlProvider>
  );
const picker = (label: string) => state.pickers.get(label) as PickerProps;
const select = (label: string) => state.selects.get(label) as SelectProps;
const labels = (label: string) =>
  select(label).options.map((option) => option.label);

it('loads the shared genre and tag lists and reports the wait to the page status', () => {
  state.swr = {};
  render();
  expect(state.swrKeys).toEqual(['/api/v1/discover/manga/filters']);
  expect(state.activity).toEqual([[true, 'manga-filter-options']]);

  state.swr = { error: new Error('unavailable') };
  render();
  expect(state.activity.at(-1)).toEqual([false, 'manga-filter-options']);
  expect(picker('Genres').noOptionsMessage()).toBe(
    'Genre and tag lists are unavailable right now.'
  );
  expect(picker('Genres').options).toEqual([]);

  state.swr = { data: catalog };
  render();
  expect(state.activity.at(-1)).toEqual([false, 'manga-filter-options']);
  expect(picker('Genres').noOptionsMessage()).toBe('No matching names');
});

it('offers AniList names and keeps chosen names that are not listed', () => {
  const markup = render({
    genres: 'Action',
    excludeGenres: 'Drama,Retired Genre,Horror',
  });

  expect(picker('Genres')).toMatchObject({
    className: 'react-select-container discover-compact-select',
    isMulti: true,
    controlShouldRenderValue: false,
    placeholder: 'Action',
    value: [{ value: 'Action' }],
  });
  expect(picker('Genres').options.map((option) => option.value)).toEqual([
    'Action',
    'Drama',
    'Horror',
  ]);
  expect(
    picker('Exclude Genres').options.map((option) => option.value)
  ).toEqual(['Action', 'Drama', 'Horror', 'Retired Genre']);
  expect(picker('Exclude Genres').placeholder).toBe('Drama +2');
  expect(picker('Tags').placeholder).toBe('Any');
  expect(picker('Exclude Tags').options.map((option) => option.value)).toEqual([
    'Isekai',
    'Time Skip',
  ]);
  expect(markup.match(/discover-filter-control-label-active/g)).toHaveLength(2);
});

it('moves a name between the include and exclude lists', () => {
  render({ genres: 'Action', excludeGenres: 'Drama,Horror', tags: 'Isekai' });

  picker('Exclude Genres').onChange([
    { value: 'Drama' },
    { value: 'Horror' },
    { value: 'Action' },
  ]);
  expect(onChange).toHaveBeenLastCalledWith({
    excludeGenres: 'Drama,Horror,Action',
    genres: undefined,
  });

  picker('Genres').onChange([{ value: 'Action' }, { value: 'Drama' }]);
  expect(onChange).toHaveBeenLastCalledWith({
    genres: 'Action,Drama',
    excludeGenres: 'Horror',
  });

  picker('Tags').onChange([]);
  expect(onChange).toHaveBeenLastCalledWith({
    tags: undefined,
    excludeTags: undefined,
  });
});

it('allows at most ten names in each list', () => {
  const names = Array.from({ length: 10 }, (_, index) => `Tag ${index}`);
  render({ tags: names.join(','), excludeTags: 'Isekai' });

  expect(picker('Tags').isOptionDisabled({ value: 'Time Skip' })).toBe(true);
  expect(picker('Tags').isOptionDisabled({ value: 'Tag 3' })).toBe(false);
  expect(picker('Tags').placeholder).toBe('Tag 0 +9');
  expect(picker('Exclude Tags').isOptionDisabled({ value: 'Time Skip' })).toBe(
    false
  );
});

it('lists formats from the content settings and keeps the chosen format', () => {
  render();
  expect(labels('Format')).toEqual(['Any', 'Manga', 'One Shot']);

  state.swr = { data: { ...catalog, formats: ['MANGA', 'ONE_SHOT', 'NOVEL'] } };
  render();
  expect(labels('Format')).toEqual(['Any', 'Manga', 'One Shot', 'Novel']);

  state.swr = {};
  render({ format: 'NOVEL' });
  expect(labels('Format')).toEqual(['Any', 'Manga', 'One Shot', 'Novel']);
  expect(select('Format').value).toBe('NOVEL');
  select('Format').onChange('');
  expect(onChange).toHaveBeenLastCalledWith({ format: undefined });
});

it('labels status, country and source material values', () => {
  render({ countryOfOrigin: 'KR' });

  expect(labels('Status')).toEqual([
    'Any',
    'Finished',
    'Releasing',
    'Not Yet Released',
    'Cancelled',
    'Hiatus',
  ]);
  expect(labels('Country')).toEqual([
    'Any',
    'Japan',
    'South Korea',
    'China',
    'Taiwan',
  ]);
  expect(select('Country').value).toBe('KR');
  expect(labels('Source Material')).toHaveLength(16);
  expect(labels('Source Material')).toContain('Light Novel');
  select('Source Material').onChange('WEB_NOVEL');
  expect(onChange).toHaveBeenLastCalledWith({ source: 'WEB_NOVEL' });
  select('Status').onChange('HIATUS');
  expect(onChange).toHaveBeenLastCalledWith({ status: 'HIATUS' });
});

it('maps range presets to minimum and maximum values', () => {
  render({ minStartYear: '2020', maxStartYear: '2020', minScore: '70' });

  expect(select('Start Year').value).toBe('2020');
  select('Start Year').onChange('before-1970');
  expect(onChange).toHaveBeenLastCalledWith({
    minStartYear: undefined,
    maxStartYear: '1969',
  });
  select('Start Year').onChange('any');
  expect(onChange).toHaveBeenLastCalledWith({
    minStartYear: undefined,
    maxStartYear: undefined,
  });

  expect(select('AniList Score')).toMatchObject({
    rating: true,
    value: '70-plus',
  });
  expect(
    select('AniList Score').options.find((option) => option.value === '90-plus')
  ).toMatchObject({ gte: '90', score: 9 });
  select('AniList Score').onChange('90-plus');
  expect(onChange).toHaveBeenLastCalledWith({
    minScore: '90',
    maxScore: undefined,
  });

  expect(select('Chapters').value).toBe('any');
  expect(labels('Chapters')).toEqual([
    'Any',
    'Up to 10',
    'Up to 50',
    '50+',
    '100+',
    '200+',
    '500+',
  ]);
  select('Chapters').onChange('up-to-10');
  expect(onChange).toHaveBeenLastCalledWith({
    minChapters: undefined,
    maxChapters: '10',
  });
  select('Volumes').onChange('20-plus');
  expect(onChange).toHaveBeenLastCalledWith({
    minVolumes: '20',
    maxVolumes: undefined,
  });
});

it('shows a range from the address that matches no preset', () => {
  render({ minStartYear: '2001', maxStartYear: '2004', maxScore: '40' });

  expect(select('Start Year').value).toBe('current');
  expect(labels('Start Year').at(-1)).toBe('Current: 2001–2004');
  select('Start Year').onChange('current');
  expect(onChange).toHaveBeenLastCalledWith({
    minStartYear: '2001',
    maxStartYear: '2004',
  });

  expect(select('AniList Score').value).toBe('current');
  expect(select('AniList Score').options.at(-1)).toMatchObject({
    label: 'Current: Any–40',
    lte: '40',
  });
});
