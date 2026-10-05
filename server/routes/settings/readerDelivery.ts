import type {
  ReaderGroupingProvider,
  ReaderGroupingTarget,
  ReaderGroupingTargetType,
} from '@server/api/readerDelivery';
import {
  buildReaderGroupingFilter,
  describeReaderGroupingRule,
  ReaderDeliveryApi,
} from '@server/api/readerDelivery';
import { getRepository } from '@server/datasource';
import ReaderDeliveryGrouping from '@server/entity/ReaderDeliveryGrouping';
import { Permission } from '@server/lib/permissions';
import type {
  ReaderDeliverySettings,
  ReaderDeliveryProvider as SettingReaderGroupingProvider,
} from '@server/lib/settings';
import {
  defaultReaderDeliverySettings,
  getSettings,
} from '@server/lib/settings';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import {
  isValidApplicationUrl,
  preserveRedactedSecrets,
  REDACTED_SECRET,
  redactSecrets,
} from '@server/utils/security';
import axios from 'axios';
import { Router } from 'express';
import { createHash } from 'node:crypto';

const readerDeliveryRoutes = Router();
const GROUPING_PENDING_TIMEOUT_MS = 2 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseServiceUrl = (
  value: unknown,
  fieldName: string
): { value: string } | { error: string } => {
  if (typeof value !== 'string' || value.length > 2048) {
    return { error: fieldName + ' must be a valid HTTP or HTTPS URL.' };
  }

  const trimmed = value.trim();
  if (!trimmed) return { value: '' };
  if (!isValidApplicationUrl(trimmed)) {
    return {
      error:
        fieldName +
        ' must be an HTTP or HTTPS URL without credentials, query parameters, or a fragment.',
    };
  }

  const normalizedUrl = trimmed.replace(/\/+$/, '');
  return {
    value: normalizedUrl.replace(/\/(?:api\/v1\/opds|komga\/api)$/i, ''),
  };
};

const parsePreferredProvider = (
  value: unknown
): SettingReaderGroupingProvider | undefined =>
  value === 'grimmory' || value === 'bookorbit' ? value : undefined;

const parseProvider = (value: unknown): ReaderGroupingProvider | undefined =>
  value === 'grimmory' || value === 'bookorbit' ? value : undefined;

const parseCredentialText = (
  value: unknown,
  fieldName: string,
  maxLength: number,
  trim = true
): { value: string } | { error: string } => {
  if (typeof value !== 'string' || value.length > maxLength) {
    return {
      error: fieldName + ' must be at most ' + maxLength + ' characters.',
    };
  }
  return { value: trim ? value.trim() : value };
};

const getSafeSettings = (settings: ReaderDeliverySettings) =>
  redactSecrets(settings) as ReaderDeliverySettings;

const getProviderConfig = (
  provider: ReaderGroupingProvider,
  settings: ReaderDeliverySettings
) =>
  provider === 'grimmory'
    ? {
        url: settings.grimmoryUrl,
        username: settings.grimmoryUsername,
        password: settings.grimmoryPassword,
      }
    : {
        url: settings.bookorbitUrl,
        username: settings.bookorbitUsername,
        password: settings.bookorbitPassword,
      };

const getConfiguredProvider = (
  provider: ReaderGroupingProvider,
  settings: ReaderDeliverySettings
): { config: ReturnType<typeof getProviderConfig> } | { error: string } => {
  const config = getProviderConfig(provider, settings);
  if (!config.url) {
    return {
      error:
        'Add the ' +
        (provider === 'grimmory' ? 'Grimmory' : 'BookOrbit') +
        ' address in Settings > Services > Reader Apps first.',
    };
  }
  if (!config.username || !config.password) {
    return {
      error:
        'Add an account username and password in Settings > Services > Reader Apps first.',
    };
  }
  return { config };
};

type ReaderLoginResult =
  | {
      api: ReaderDeliveryApi;
      token: string;
      config: ReturnType<typeof getProviderConfig>;
    }
  | { error: string };

const getProviderError = (
  error: unknown,
  provider: ReaderGroupingProvider
): string => {
  const providerName = provider === 'grimmory' ? 'Grimmory' : 'BookOrbit';
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401 || status === 403) {
    return (
      providerName +
      ' rejected these credentials or the account cannot manage groupings. Check the username, password, and account permissions.'
    );
  }
  if (status === 404) {
    return (
      providerName +
      ' did not recognize the grouping API. Check that the service version and address are correct.'
    );
  }
  if (
    status === 413 ||
    (axios.isAxiosError(error) && error.code === 'ERR_BAD_RESPONSE')
  ) {
    return (
      providerName +
      ' returned a response that was too large to process safely.'
    );
  }
  return (
    'SeerrNG could not complete the request to ' +
    providerName +
    '. Check the service address and try again.'
  );
};

const parseTarget = (
  value: unknown
): { target: ReaderGroupingTarget } | { error: string } => {
  if (!isRecord(value)) return { error: 'Choose a valid author or series.' };
  const type = value.type;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (
    !['author', 'book-series', 'comic-series'].includes(String(type)) ||
    !id ||
    id.length > 255 ||
    !name ||
    name.length > 255
  ) {
    return { error: 'Choose a valid author or series.' };
  }
  return {
    target: {
      type: type as ReaderGroupingTargetType,
      id,
      name,
    },
  };
};

const parseOptionalBoolean = (
  value: unknown,
  fieldName: string
): { value?: boolean } | { error: string } => {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    return { error: fieldName + ' must be true or false.' };
  }
  return { value };
};

const createGroupName = (
  provider: ReaderGroupingProvider,
  target: ReaderGroupingTarget
) => {
  const typeLabel =
    target.type === 'author'
      ? 'Author'
      : target.type === 'comic-series'
        ? 'Comic Series'
        : 'Book Series';
  const hash = createHash('sha256')
    .update(provider + '\0' + target.type + '\0' + target.id)
    .digest('hex')
    .slice(0, 12);
  const prefix = 'SeerrNG · ' + typeLabel + ' · ';
  const suffix = ' [' + hash + ']';
  return (
    prefix + target.name.slice(0, 255 - prefix.length - suffix.length) + suffix
  );
};

const toPublicGrouping = (
  grouping: ReaderDeliveryGrouping,
  serviceUrl: string
) => ({
  id: grouping.id,
  provider: grouping.provider,
  targetType: grouping.targetType,
  targetId: grouping.targetId,
  targetName: grouping.targetName,
  groupName: grouping.groupName,
  remoteGroupId: grouping.remoteGroupId,
  isPublic: grouping.isPublic,
  syncToKobo: grouping.syncToKobo,
  status: grouping.status,
  lastMatchCount: grouping.lastMatchCount,
  countVerified: grouping.countVerified,
  lastError: grouping.lastError,
  lastSyncedAt: grouping.lastSyncedAt,
  serviceUrl,
});

const getServiceUrl = (
  provider: ReaderGroupingProvider,
  settings: ReaderDeliverySettings
) => getProviderConfig(provider, settings).url;

const performLogin = async (
  provider: ReaderGroupingProvider,
  settings: ReaderDeliverySettings
): Promise<ReaderLoginResult> => {
  const configured = getConfiguredProvider(provider, settings);
  if ('error' in configured) return configured;
  const api = new ReaderDeliveryApi(configured.config.url);
  const token = await api.login(provider, configured.config);
  return { api, token, config: configured.config };
};

readerDeliveryRoutes.get('/', (_req, res) => {
  const settings =
    getSettings().readerDelivery ?? defaultReaderDeliverySettings();
  return res.status(200).json(getSafeSettings(settings));
});

readerDeliveryRoutes.put(
  '/',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    if (!isRecord(req.body)) {
      return res
        .status(400)
        .json({ error: 'Reader delivery settings must be an object.' });
    }

    const current =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    const grimmoryUrl = parseServiceUrl(
      req.body.grimmoryUrl ?? current.grimmoryUrl,
      'Grimmory URL'
    );
    if ('error' in grimmoryUrl) {
      return res.status(400).json({ error: grimmoryUrl.error });
    }

    const bookorbitUrl = parseServiceUrl(
      req.body.bookorbitUrl ?? current.bookorbitUrl,
      'BookOrbit URL'
    );
    if ('error' in bookorbitUrl) {
      return res.status(400).json({ error: bookorbitUrl.error });
    }

    const requestedPreferred =
      req.body.preferredProvider === undefined
        ? current.preferredProvider
        : parsePreferredProvider(req.body.preferredProvider);
    if (!requestedPreferred) {
      return res.status(400).json({
        error: 'Choose Grimmory or BookOrbit as the preferred reader service.',
      });
    }

    const grimmoryUsername = parseCredentialText(
      req.body.grimmoryUsername ?? current.grimmoryUsername,
      'Grimmory username',
      256
    );
    const bookorbitUsername = parseCredentialText(
      req.body.bookorbitUsername ?? current.bookorbitUsername,
      'BookOrbit username',
      256
    );
    const grimmoryPassword = parseCredentialText(
      req.body.grimmoryPassword === REDACTED_SECRET
        ? current.grimmoryPassword
        : (req.body.grimmoryPassword ?? current.grimmoryPassword),
      'Grimmory password',
      2048,
      false
    );
    const bookorbitPassword = parseCredentialText(
      req.body.bookorbitPassword === REDACTED_SECRET
        ? current.bookorbitPassword
        : (req.body.bookorbitPassword ?? current.bookorbitPassword),
      'BookOrbit password',
      2048,
      false
    );
    if ('error' in grimmoryUsername)
      return res.status(400).json({ error: grimmoryUsername.error });
    if ('error' in bookorbitUsername)
      return res.status(400).json({ error: bookorbitUsername.error });
    if ('error' in grimmoryPassword)
      return res.status(400).json({ error: grimmoryPassword.error });
    if ('error' in bookorbitPassword)
      return res.status(400).json({ error: bookorbitPassword.error });

    const clearGrimmoryCredentials = req.body.clearGrimmoryCredentials === true;
    const clearBookorbitCredentials =
      req.body.clearBookorbitCredentials === true;
    const candidate: ReaderDeliverySettings = {
      grimmoryUrl: grimmoryUrl.value,
      grimmoryUsername: clearGrimmoryCredentials ? '' : grimmoryUsername.value,
      grimmoryPassword: clearGrimmoryCredentials ? '' : grimmoryPassword.value,
      bookorbitUrl: bookorbitUrl.value,
      bookorbitUsername: clearBookorbitCredentials
        ? ''
        : bookorbitUsername.value,
      bookorbitPassword: clearBookorbitCredentials
        ? ''
        : bookorbitPassword.value,
      preferredProvider: requestedPreferred,
    };
    const safeCandidate = preserveRedactedSecrets(candidate, current);
    const saved = await getSettings().persistSection(
      'readerDelivery',
      () => safeCandidate
    );

    return res.status(200).json(getSafeSettings(saved));
  })
);

readerDeliveryRoutes.post(
  '/connection-test',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const provider = parseProvider(
      isRecord(req.body) ? req.body.provider : undefined
    );
    if (!provider) {
      return res.status(400).json({ error: 'Choose Grimmory or BookOrbit.' });
    }
    const settings =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    try {
      const result = await performLogin(provider, settings);
      if ('error' in result) return res.status(400).json(result);
      const groupings = await result.api.listGroupings(provider, result.token);
      return res.status(200).json({
        connected: true,
        provider,
        existingGroupingCount: groupings.length,
      });
    } catch (error) {
      return res.status(502).json({ error: getProviderError(error, provider) });
    }
  })
);

readerDeliveryRoutes.get('/groupings', async (_req, res) => {
  const settings =
    getSettings().readerDelivery ?? defaultReaderDeliverySettings();
  const groupings = await getRepository(ReaderDeliveryGrouping).find({
    order: { updatedAt: 'DESC', id: 'DESC' },
  });
  return res
    .status(200)
    .json(
      groupings.map((grouping) =>
        toPublicGrouping(grouping, getServiceUrl(grouping.provider, settings))
      )
    );
});

readerDeliveryRoutes.post(
  '/groupings/preview',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Preview details are required.' });
    }
    const provider = parseProvider(req.body.provider);
    const parsedTarget = parseTarget(req.body.target);
    if (!provider)
      return res.status(400).json({ error: 'Choose a reader service.' });
    if ('error' in parsedTarget) {
      return res.status(400).json({ error: parsedTarget.error });
    }
    const settings =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    try {
      const result = await performLogin(provider, settings);
      if ('error' in result) return res.status(400).json(result);
      const preview = await result.api.preview(
        provider,
        result.token,
        parsedTarget.target
      );
      return res.status(200).json({
        provider,
        target: parsedTarget.target,
        rule: buildReaderGroupingFilter(provider, parsedTarget.target),
        ruleSummary: describeReaderGroupingRule(parsedTarget.target),
        ...preview,
      });
    } catch (error) {
      return res.status(502).json({ error: getProviderError(error, provider) });
    }
  })
);

readerDeliveryRoutes.post(
  '/groupings',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Grouping details are required.' });
    }
    const provider = parseProvider(req.body.provider);
    const parsedTarget = parseTarget(req.body.target);
    const isPublic = parseOptionalBoolean(
      req.body.isPublic,
      'Share with users'
    );
    const syncToKobo = parseOptionalBoolean(req.body.syncToKobo, 'Kobo sync');
    const allowEmpty = parseOptionalBoolean(
      req.body.allowEmpty,
      'Create empty grouping'
    );
    if (!provider)
      return res.status(400).json({ error: 'Choose a reader service.' });
    if ('error' in parsedTarget) {
      return res.status(400).json({ error: parsedTarget.error });
    }
    if ('error' in isPublic)
      return res.status(400).json({ error: isPublic.error });
    if ('error' in syncToKobo)
      return res.status(400).json({ error: syncToKobo.error });
    if ('error' in allowEmpty)
      return res.status(400).json({ error: allowEmpty.error });

    const target = parsedTarget.target;
    const settings =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    const repository = getRepository(ReaderDeliveryGrouping);
    let grouping = await repository.findOne({
      where: { provider, targetType: target.type, targetId: target.id },
    });
    const resolvedIsPublic = isPublic.value ?? grouping?.isPublic ?? true;
    const resolvedSyncToKobo =
      provider === 'bookorbit'
        ? (syncToKobo.value ?? grouping?.syncToKobo ?? false)
        : false;

    if (
      grouping &&
      provider === 'bookorbit' &&
      grouping.isPublic !== resolvedIsPublic
    ) {
      return res.status(409).json({
        error:
          'BookOrbit sets scope visibility when the scope is created. Change this grouping’s visibility in BookOrbit, or remove the SeerrNG-managed scope and create it again.',
      });
    }
    if (
      grouping?.status === 'pending' &&
      grouping.updatedAt &&
      Date.now() - new Date(grouping.updatedAt).getTime() <
        GROUPING_PENDING_TIMEOUT_MS
    ) {
      return res.status(409).json({
        error:
          'This grouping is already being updated. Wait a moment and refresh.',
      });
    }

    let login: Awaited<ReturnType<typeof performLogin>>;
    try {
      login = await performLogin(provider, settings);
      if ('error' in login) return res.status(400).json(login);
    } catch (error) {
      return res.status(502).json({ error: getProviderError(error, provider) });
    }

    let preview;
    try {
      preview = await login.api.preview(provider, login.token, target);
    } catch (error) {
      return res.status(502).json({ error: getProviderError(error, provider) });
    }
    if (preview.matchedCount === 0 && allowEmpty.value !== true) {
      return res.status(409).json({
        code: 'empty-match',
        error:
          'No current books match this rule. You can still create it for books added to the reader library later.',
        matchedCount: 0,
        sampleTitles: [],
      });
    }

    if (!grouping) {
      grouping = repository.create({
        provider,
        targetType: target.type,
        targetId: target.id,
        targetName: target.name,
        groupName: createGroupName(provider, target),
        remoteGroupId: null,
        isPublic: resolvedIsPublic,
        syncToKobo: resolvedSyncToKobo,
        status: 'pending',
        lastMatchCount: preview.matchedCount,
        countVerified: false,
        lastError: null,
        lastSyncedAt: null,
      });
    } else {
      grouping.targetName = target.name;
      grouping.isPublic = resolvedIsPublic;
      grouping.syncToKobo = resolvedSyncToKobo;
      grouping.status = 'pending';
      grouping.lastMatchCount = preview.matchedCount;
      grouping.countVerified = false;
      grouping.lastError = null;
    }

    try {
      grouping = await repository.save(grouping);
    } catch {
      return res.status(409).json({
        error:
          'Another update for this grouping just started. Refresh and try again.',
      });
    }

    try {
      const recoveredId = grouping.remoteGroupId
        ? undefined
        : await login.api.findGroupingIdByName(
            provider,
            login.token,
            grouping.groupName
          );
      const remoteGroupId = await login.api.saveGrouping(
        provider,
        login.token,
        {
          id: grouping.remoteGroupId ?? recoveredId,
          name: grouping.groupName,
          filter: buildReaderGroupingFilter(provider, target),
          isPublic: resolvedIsPublic,
          syncToKobo: resolvedSyncToKobo,
        }
      );
      grouping.remoteGroupId = remoteGroupId;

      let finalCount = preview.matchedCount;
      let countVerified = false;
      let warning: string | undefined;
      try {
        finalCount = await login.api.getGroupingCount(
          provider,
          login.token,
          remoteGroupId
        );
        countVerified = true;
      } catch {
        warning =
          'The grouping was saved, but the reader service did not confirm its final item count. Open the service and refresh this grouping to check it.';
      }

      grouping.status = 'ready';
      grouping.lastMatchCount = finalCount;
      grouping.countVerified = countVerified;
      grouping.lastError = null;
      grouping.lastSyncedAt = new Date();
      grouping = await repository.save(grouping);
      return res.status(200).json({
        grouping: toPublicGrouping(grouping, getServiceUrl(provider, settings)),
        previewCount: preview.matchedCount,
        sampleTitles: preview.sampleTitles,
        ruleSummary: describeReaderGroupingRule(target),
        warning,
      });
    } catch (error) {
      const publicError = getProviderError(error, provider);
      grouping.status = 'error';
      grouping.lastError = publicError;
      grouping.lastSyncedAt = new Date();
      await repository.save(grouping);
      return res.status(502).json({
        error: publicError,
        grouping: toPublicGrouping(grouping, getServiceUrl(provider, settings)),
      });
    }
  })
);

readerDeliveryRoutes.delete(
  '/groupings/:id',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Grouping ID is invalid.' });
    }
    const repository = getRepository(ReaderDeliveryGrouping);
    const grouping = await repository.findOne({ where: { id } });
    if (!grouping)
      return res.status(404).json({ error: 'Grouping not found.' });
    const settings =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    if (grouping.remoteGroupId) {
      try {
        const result = await performLogin(grouping.provider, settings);
        if ('error' in result) return res.status(400).json(result);
        await result.api.deleteGrouping(
          grouping.provider,
          result.token,
          grouping.remoteGroupId
        );
      } catch (error) {
        if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
          return res.status(502).json({
            error: getProviderError(error, grouping.provider),
          });
        }
      }
    }
    await repository.remove(grouping);
    return res.status(200).json({ deleted: true });
  })
);

export default readerDeliveryRoutes;
