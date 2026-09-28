import ProwlarrAPI from '@server/api/prowlarr';
import { MEDIA_CATEGORY_KEYS } from '@server/constants/mediaCategories';
import type { ProwlarrCategoryMappings } from '@server/constants/prowlarr';
import { Permission } from '@server/lib/permissions';
import { summarizeProwlarrCoverage } from '@server/lib/prowlarr';
import type { ProwlarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import {
  REDACTED_SECRET,
  preserveRedactedSecrets,
} from '@server/utils/security';
import {
  normalizeServiceHostname,
  normalizeUrlBase,
} from '@server/utils/serviceUrl';
import { Router } from 'express';

const prowlarrRoutes = Router();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseCategoryMappings = (
  value: unknown,
  current: ProwlarrCategoryMappings
): { value: ProwlarrCategoryMappings } | { error: string } => {
  if (value === undefined) return { value: current };
  if (!isRecord(value))
    return { error: 'Category mappings must be an object.' };

  const knownCategories = new Set<string>(MEDIA_CATEGORY_KEYS);
  if (Object.keys(value).some((category) => !knownCategories.has(category))) {
    return { error: 'Category mappings contain an unsupported media type.' };
  }

  const result = {} as ProwlarrCategoryMappings;
  for (const category of MEDIA_CATEGORY_KEYS) {
    const rawIds = value[category] ?? current[category];
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 32) {
      return {
        error: `${category} must have between 1 and 32 indexer category IDs.`,
      };
    }
    const ids: number[] = [];
    for (const id of rawIds) {
      if (
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        id > 1_000_000
      ) {
        return { error: `${category} has an invalid indexer category ID.` };
      }
      if (!ids.includes(id)) ids.push(id);
    }
    result[category] = ids;
  }
  return { value: result };
};

export const parseProwlarrSettings = (
  value: unknown,
  current: ProwlarrSettings
): { value: ProwlarrSettings } | { error: string } => {
  if (!isRecord(value)) {
    return { error: 'Prowlarr settings must be an object.' };
  }

  const hostnameValue = value.hostname ?? current.hostname;
  const hostname =
    typeof hostnameValue === 'string' && hostnameValue.length <= 255
      ? normalizeServiceHostname(hostnameValue)
      : '';
  if (hostnameValue !== '' && !hostname) {
    return { error: 'Prowlarr hostname is invalid.' };
  }

  const port = value.port ?? current.port ?? 9696;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return { error: 'Prowlarr port must be between 1 and 65535.' };
  }

  const useSsl = value.useSsl ?? current.useSsl;
  if (typeof useSsl !== 'boolean') {
    return { error: 'Prowlarr SSL setting must be a boolean.' };
  }

  const baseUrlValue = value.baseUrl ?? current.baseUrl;
  if (typeof baseUrlValue !== 'string' || baseUrlValue.length > 512) {
    return { error: 'Prowlarr base path is invalid.' };
  }
  const baseUrl = normalizeUrlBase(baseUrlValue);
  if (baseUrlValue !== '' && !baseUrl) {
    return { error: 'Prowlarr base path is invalid.' };
  }

  const clearApiKey = value.clearApiKey === true;
  const providedApiKey = value.apiKey;
  let apiKey = current.apiKey;
  if (clearApiKey) {
    apiKey = '';
  } else if (
    typeof providedApiKey === 'string' &&
    providedApiKey !== REDACTED_SECRET &&
    providedApiKey !== ''
  ) {
    apiKey = providedApiKey;
  } else if (
    providedApiKey !== undefined &&
    typeof providedApiKey !== 'string'
  ) {
    return { error: 'Prowlarr API key is invalid.' };
  }
  if (apiKey.length > 2048 || /[\r\n\0]/.test(apiKey)) {
    return { error: 'Prowlarr API key is invalid.' };
  }

  const categoryMappings = parseCategoryMappings(
    value.categoryMappings,
    current.categoryMappings
  );
  if ('error' in categoryMappings) return categoryMappings;

  return {
    value: {
      hostname,
      port,
      useSsl,
      baseUrl,
      apiKey,
      categoryMappings: categoryMappings.value,
    },
  };
};

const settingsView = (settings: ProwlarrSettings) => ({
  ...settings,
  apiKey: settings.apiKey ? REDACTED_SECRET : '',
  apiKeyConfigured: Boolean(settings.apiKey),
});

const getInventory = async (settings: ProwlarrSettings) => {
  const api = new ProwlarrAPI(settings);
  const [status, indexers] = await Promise.all([
    api.getSystemStatus(),
    api.getIndexers(),
  ]);
  return {
    success: true,
    version:
      typeof status.version === 'string' && status.version.length <= 64
        ? status.version
        : undefined,
    ...summarizeProwlarrCoverage(indexers, settings.categoryMappings),
  };
};

prowlarrRoutes.get('/', (_req, res) => {
  res.status(200).json(settingsView(getSettings().prowlarr));
});

prowlarrRoutes.get('/coverage', async (_req, res) => {
  const settings = getSettings().prowlarr;
  if (!settings.hostname || !settings.apiKey) {
    return res.status(200).json({ configured: false });
  }

  try {
    const inventory = await getInventory(settings);
    return res.status(200).json({ configured: true, ...inventory });
  } catch {
    return res.status(502).json({
      configured: true,
      error: 'Prowlarr inventory could not be loaded.',
    });
  }
});

prowlarrRoutes.put(
  '/',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const settings = getSettings();
    const parsed = parseProwlarrSettings(req.body, settings.prowlarr);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const saved = await settings.persistSection(
        'prowlarr',
        (current) =>
          preserveRedactedSecrets(parsed.value, current) as ProwlarrSettings
      );
      return res.status(200).json(settingsView(saved));
    } catch {
      return res
        .status(500)
        .json({ error: 'Prowlarr settings could not be saved.' });
    }
  })
);

prowlarrRoutes.post(
  '/test',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const parsed = parseProwlarrSettings(req.body, getSettings().prowlarr);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!parsed.value.hostname || !parsed.value.apiKey) {
      return res
        .status(400)
        .json({ error: 'Prowlarr hostname and API key are required.' });
    }

    try {
      return res.status(200).json(await getInventory(parsed.value));
    } catch {
      return res.status(502).json({
        error: 'Prowlarr connection failed. Check its address and API key.',
      });
    }
  })
);

export default prowlarrRoutes;
