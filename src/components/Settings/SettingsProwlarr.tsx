import SelectionCircle from '@app/components/Common/SelectionCircle';
import defineMessages from '@app/utils/defineMessages';
import { detectProwlarrCategoryMatches } from '@app/utils/prowlarrCategories';
import {
  DEFAULT_PROWLARR_CATEGORY_LABELS,
  type ProwlarrCategoryMappings,
} from '@server/constants/prowlarr';
import type { ProwlarrSettings } from '@server/lib/settings';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.SettingsProwlarr', {
  title: 'Prowlarr indexers',
  description:
    'Connect your Prowlarr instance once to run category-aware manual searches across the indexers you already manage there.',
  address: 'Hostname',
  port: 'Port',
  basePath: 'Base path',
  useSsl: 'Use SSL',
  apiKey: 'API key',
  apiKeySaved: 'A key is saved. Leave this blank to keep using it.',
  clearApiKey: 'Remove saved API key',
  keepApiKey: 'Keep saved API key',
  test: 'Test connection and inspect coverage',
  testing: 'Checking Prowlarr…',
  save: 'Save Prowlarr settings',
  saving: 'Saving…',
  connected: 'Connected to Prowlarr {version}.',
  saved: 'Prowlarr settings saved.',
  testFailed: 'Prowlarr connection failed. Check the address and API key.',
  saveFailed: 'Prowlarr settings could not be saved.',
  loadFailed: 'Prowlarr settings could not be loaded.',
  coverageTitle: 'Indexer coverage by medium',
  coverageDescription:
    'Counts include enabled, searchable indexers that advertise support for at least one selected category. They show search coverage, not successful grabs or imports.',
  inventoryFailed:
    'Prowlarr is saved, but its indexer inventory is unavailable.',
  totalIndexers: '{enabled} searchable and enabled of {total} configured',
  categoryMappingTitle: 'Category filters',
  categoryMappingDescription:
    'Choose the Prowlarr categories sent with each search. Defaults use standard Newznab/Torznab categories; test the connection to see custom categories advertised by enabled indexers.',
  detectedMatchesHelp:
    'Suggested custom categories are matched by their advertised names. Review them before saving; this does not change Prowlarr or send downloads.',
  addDetectedMatches: 'Add detected matches ({count})',
  selectedCategories: '{count} categories selected',
  categoryMappingEmpty: 'Select at least one category.',
  movie: 'Movies',
  tv: 'TV',
  music: 'Music',
  ebook: 'Books',
  audiobook: 'Audiobooks',
  comic: 'Comics',
  magazine: 'Magazines',
  retro: 'Retro ROMs',
  modern: 'Modern ROMs',
  game: 'PC games',
  noConfiguredIndexers: 'No Prowlarr indexers are configured yet.',
  noSearchableIndexers:
    'No enabled searchable indexers are available. Enable an indexer in Prowlarr or adjust the category filters.',
  testHint:
    'Searches started from SeerrNG query Prowlarr directly. Approved requests still go through their configured media manager or software provider, which owns acquisition and tracking.',
});

type MediaCategoryKey = keyof ProwlarrCategoryMappings;

interface ProwlarrSettingsResponse extends ProwlarrSettings {
  apiKeyConfigured: boolean;
}

interface ProwlarrCoverageResponse {
  configured: boolean;
  success?: boolean;
  version?: string;
  totalIndexers?: number;
  enabledSearchableIndexers?: number;
  categories?: Record<MediaCategoryKey, number>;
  categoryCatalog?: { id: number; name: string; indexerCount: number }[];
  error?: string;
}

interface ProwlarrForm extends Omit<ProwlarrSettings, 'apiKey'> {
  apiKey: string;
  apiKeyConfigured: boolean;
  clearApiKey: boolean;
}

const categoryKeys: MediaCategoryKey[] = [
  'movie',
  'tv',
  'music',
  'ebook',
  'audiobook',
  'comic',
  'magazine',
  'retro',
  'modern',
  'game',
];

const categoryMessages: Record<MediaCategoryKey, keyof typeof messages> = {
  movie: 'movie',
  tv: 'tv',
  music: 'music',
  ebook: 'ebook',
  audiobook: 'audiobook',
  comic: 'comic',
  magazine: 'magazine',
  retro: 'retro',
  modern: 'modern',
  game: 'game',
};

const toForm = (settings: ProwlarrSettingsResponse): ProwlarrForm => ({
  hostname: settings.hostname,
  port: settings.port,
  useSsl: settings.useSsl,
  baseUrl: settings.baseUrl,
  apiKey: '',
  apiKeyConfigured: settings.apiKeyConfigured,
  clearApiKey: false,
  categoryMappings: settings.categoryMappings,
});

const getPayload = (form: ProwlarrForm) => ({
  hostname: form.hostname,
  port: Number(form.port),
  useSsl: form.useSsl,
  baseUrl: form.baseUrl,
  categoryMappings: form.categoryMappings,
  clearApiKey: form.clearApiKey,
  ...(form.apiKey ? { apiKey: form.apiKey } : {}),
});

const SettingsProwlarr = () => {
  const intl = useIntl();
  const { data, error } = useSWR<ProwlarrSettingsResponse>(
    '/api/v1/settings/prowlarr'
  );
  const { data: savedCoverage, mutate: revalidateCoverage } =
    useSWR<ProwlarrCoverageResponse>('/api/v1/settings/prowlarr/coverage', {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    });
  const [form, setForm] = useState<ProwlarrForm | null>(null);
  const [inventory, setInventory] = useState<ProwlarrCoverageResponse | null>(
    null
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  const usingSavedConnection = Boolean(
    data &&
    form &&
    form.hostname === data.hostname &&
    form.port === data.port &&
    form.useSsl === data.useSsl &&
    form.baseUrl === data.baseUrl &&
    !form.apiKey &&
    !form.clearApiKey
  );
  const availableCategoryCatalog =
    inventory?.categoryCatalog ??
    (usingSavedConnection ? savedCoverage?.categoryCatalog : undefined) ??
    [];

  const categoryOptions = useMemo(() => {
    const options = new Map<number, { name: string; indexerCount: number }>();
    for (const [id, name] of Object.entries(DEFAULT_PROWLARR_CATEGORY_LABELS)) {
      options.set(Number(id), { name, indexerCount: 0 });
    }
    for (const item of availableCategoryCatalog) {
      options.set(item.id, {
        name: item.name,
        indexerCount: item.indexerCount,
      });
    }
    for (const ids of Object.values(form?.categoryMappings ?? {})) {
      for (const id of ids) {
        if (!options.has(id)) {
          options.set(id, {
            name: `Category ${id}`,
            indexerCount: 0,
          });
        }
      }
    }
    return [...options.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .sort((left, right) => left.id - right.id);
  }, [form?.categoryMappings, availableCategoryCatalog]);

  const updateForm = (update: Partial<ProwlarrForm>) => {
    if (
      ['hostname', 'port', 'useSsl', 'baseUrl', 'apiKey', 'clearApiKey'].some(
        (key) => key in update
      )
    ) {
      setInventory(null);
      setConnectionMessage('');
    }
    setForm((current) => (current ? { ...current, ...update } : current));
  };

  const updateCategories = (category: MediaCategoryKey, value: string[]) => {
    if (!form) return;
    updateForm({
      categoryMappings: {
        ...form.categoryMappings,
        [category]: value.map(Number).filter(Number.isSafeInteger),
      },
    });
  };

  const testConnection = async () => {
    if (!form) return;
    setTesting(true);
    setConnectionMessage('');
    setErrorMessage('');
    try {
      const response = await axios.post<ProwlarrCoverageResponse>(
        '/api/v1/settings/prowlarr/test',
        getPayload(form)
      );
      setInventory(response.data);
      setConnectionMessage(
        intl.formatMessage(messages.connected, {
          version: response.data.version || 'Prowlarr',
        })
      );
    } catch {
      setInventory(null);
      setErrorMessage(intl.formatMessage(messages.testFailed));
    } finally {
      setTesting(false);
    }
  };

  const saveSettings = async () => {
    if (!form) return;
    setSaving(true);
    setSaveMessage('');
    setErrorMessage('');
    try {
      await axios.put('/api/v1/settings/prowlarr', getPayload(form));
      await Promise.all([
        mutate('/api/v1/settings/prowlarr'),
        revalidateCoverage(),
        mutate('/api/v1/indexer-search/configuration'),
      ]);
      setSaveMessage(intl.formatMessage(messages.saved));
      updateForm({
        apiKey: '',
        apiKeyConfigured: form.apiKeyConfigured || !!form.apiKey,
        clearApiKey: false,
      });
    } catch {
      setErrorMessage(intl.formatMessage(messages.saveFailed));
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div
        className="mt-8 rounded-lg border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-100"
        role="alert"
      >
        {intl.formatMessage(messages.loadFailed)}
      </div>
    );
  }
  if (!form) return null;

  const coverage = inventory ?? savedCoverage;
  const canSaveCategories = categoryKeys.every(
    (category) => (form.categoryMappings[category] ?? []).length > 0
  );

  return (
    <section
      id="prowlarr"
      className="app-card-sub section mt-8 p-4 sm:p-6"
      aria-labelledby="prowlarr-settings-title"
    >
      <div className="mb-5">
        <h3 id="prowlarr-settings-title" className="heading">
          {intl.formatMessage(messages.title)}
        </h3>
        <p className="description mt-1">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="text-sm text-gray-200">
          {intl.formatMessage(messages.address)}
          <input
            className="input input-lite mt-1 w-full"
            autoComplete="off"
            value={form.hostname}
            onChange={(event) => updateForm({ hostname: event.target.value })}
          />
        </label>
        <label className="text-sm text-gray-200">
          {intl.formatMessage(messages.port)}
          <input
            className="input input-lite mt-1 w-full"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(event) =>
              updateForm({ port: Number(event.target.value) })
            }
          />
        </label>
        <label className="text-sm text-gray-200 sm:col-span-2">
          {intl.formatMessage(messages.basePath)}
          <input
            className="input input-lite mt-1 w-full"
            autoComplete="off"
            value={form.baseUrl}
            onChange={(event) => updateForm({ baseUrl: event.target.value })}
          />
        </label>
        <label className="text-sm text-gray-200 sm:col-span-2">
          {intl.formatMessage(messages.apiKey)}
          <input
            className="input input-lite mt-1 w-full"
            type="password"
            autoComplete="new-password"
            value={form.apiKey}
            onChange={(event) =>
              updateForm({ apiKey: event.target.value, clearApiKey: false })
            }
          />
          {form.apiKeyConfigured && !form.clearApiKey && (
            <span className="mt-1 block text-xs text-gray-400">
              {intl.formatMessage(messages.apiKeySaved)}
            </span>
          )}
        </label>
        <div className="inline-flex items-center gap-2 text-sm text-gray-200 sm:col-span-2">
          <span>{intl.formatMessage(messages.useSsl)}</span>
          <SelectionCircle
            id="prowlarr-use-ssl"
            name="useSsl"
            label={intl.formatMessage(messages.useSsl)}
            selected={form.useSsl}
            onClick={() => updateForm({ useSsl: !form.useSsl })}
          />
        </div>
      </div>

      {form.apiKeyConfigured && (
        <button
          type="button"
          className="mt-3 text-sm text-indigo-300 underline hover:text-indigo-200"
          onClick={() =>
            updateForm({ clearApiKey: !form.clearApiKey, apiKey: '' })
          }
        >
          {intl.formatMessage(
            form.clearApiKey ? messages.keepApiKey : messages.clearApiKey
          )}
        </button>
      )}

      <div className="mt-5 rounded-lg border border-gray-700 bg-gray-900/50 p-4">
        <h4 className="font-semibold text-white">
          {intl.formatMessage(messages.categoryMappingTitle)}
        </h4>
        <p className="mt-1 text-sm text-gray-300">
          {intl.formatMessage(messages.categoryMappingDescription)}
        </p>
        <p className="mt-1 text-xs text-gray-400">
          {intl.formatMessage(messages.detectedMatchesHelp)}
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
          {categoryKeys.map((category) => {
            const selectedIds = form.categoryMappings[category] ?? [];
            const detectedMatches = detectProwlarrCategoryMatches(
              category,
              availableCategoryCatalog
            ).filter((id) => !selectedIds.includes(id));
            return (
              <details
                key={category}
                className="rounded border border-gray-700 px-3 py-2"
              >
                <summary className="cursor-pointer text-sm font-medium text-gray-100">
                  {intl.formatMessage(messages[categoryMessages[category]])}
                  <span className="ml-2 text-xs text-gray-400">
                    {intl.formatMessage(messages.selectedCategories, {
                      count: selectedIds.length,
                    })}
                  </span>
                </summary>
                <select
                  aria-label={intl.formatMessage(
                    messages[categoryMessages[category]]
                  )}
                  multiple
                  size={Math.min(6, Math.max(3, categoryOptions.length))}
                  className="input input-lite mt-2 w-full"
                  value={selectedIds.map(String)}
                  onChange={(event) =>
                    updateCategories(
                      category,
                      Array.from(
                        event.target.selectedOptions,
                        (option) => option.value
                      )
                    )
                  }
                >
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({option.id})
                      {option.indexerCount
                        ? ` · ${option.indexerCount} indexers`
                        : ''}
                    </option>
                  ))}
                </select>
                {detectedMatches.length > 0 && (
                  <button
                    type="button"
                    className="mt-2 rounded border border-indigo-400/60 px-3 py-1.5 text-sm text-indigo-200 hover:bg-indigo-950/40"
                    onClick={() =>
                      updateCategories(category, [
                        ...selectedIds.map(String),
                        ...detectedMatches.map(String),
                      ])
                    }
                  >
                    {intl.formatMessage(messages.addDetectedMatches, {
                      count: detectedMatches.length,
                    })}
                  </button>
                )}
                {selectedIds.length === 0 && (
                  <p className="mt-1 text-sm text-red-300" role="alert">
                    {intl.formatMessage(messages.categoryMappingEmpty)}
                  </p>
                )}
              </details>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-sm text-gray-300">
        {intl.formatMessage(messages.testHint)}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            testing ||
            !form.hostname ||
            form.clearApiKey ||
            (!form.apiKey && !form.apiKeyConfigured) ||
            !canSaveCategories
          }
          onClick={() => void testConnection()}
        >
          {intl.formatMessage(testing ? messages.testing : messages.test)}
        </button>
        <button
          type="button"
          className="rounded border border-gray-500 px-4 py-2 font-semibold text-gray-100 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={saving || !canSaveCategories}
          onClick={() => void saveSettings()}
        >
          {intl.formatMessage(saving ? messages.saving : messages.save)}
        </button>
      </div>

      {connectionMessage && (
        <p className="mt-3 text-sm text-green-300" role="status">
          {connectionMessage}
        </p>
      )}
      {saveMessage && (
        <p className="mt-2 text-sm text-green-300" role="status">
          {saveMessage}
        </p>
      )}
      {errorMessage && (
        <p className="mt-3 text-sm text-red-300" role="alert">
          {errorMessage}
        </p>
      )}

      {coverage?.configured && coverage.error && (
        <p className="mt-4 text-sm text-amber-200" role="status">
          {intl.formatMessage(messages.inventoryFailed)}
        </p>
      )}
      {coverage?.configured && coverage.success && (
        <div className="mt-5">
          <h4 className="font-semibold text-white">
            {intl.formatMessage(messages.coverageTitle)}
          </h4>
          <p className="mt-1 text-sm text-gray-300">
            {intl.formatMessage(messages.coverageDescription)}
          </p>
          <p className="mt-2 text-sm text-gray-200">
            {intl.formatMessage(messages.totalIndexers, {
              enabled: coverage.enabledSearchableIndexers ?? 0,
              total: coverage.totalIndexers ?? 0,
            })}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {categoryKeys.map((category) => (
              <li
                key={category}
                className="flex items-center justify-between rounded border border-gray-700 px-3 py-2 text-sm"
              >
                <span className="text-gray-100">
                  {intl.formatMessage(messages[categoryMessages[category]])}
                </span>
                <span className="font-semibold text-indigo-200">
                  {coverage.categories?.[category] ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {coverage?.configured &&
        !coverage.error &&
        coverage.totalIndexers === 0 && (
          <p className="mt-4 text-sm text-amber-200" role="status">
            {intl.formatMessage(messages.noConfiguredIndexers)}
          </p>
        )}
      {coverage?.configured &&
        !coverage.error &&
        (coverage.enabledSearchableIndexers ?? 0) === 0 &&
        (coverage.totalIndexers ?? 0) > 0 && (
          <p className="mt-4 text-sm text-amber-200" role="status">
            {intl.formatMessage(messages.noSearchableIndexers)}
          </p>
        )}
    </section>
  );
};

export default SettingsProwlarr;
