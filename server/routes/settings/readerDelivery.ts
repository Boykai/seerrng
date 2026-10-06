import type {
  ReaderGroupingProvider,
  ReaderGroupingTarget,
  ReaderGroupingTargetType,
  ReaderServiceStep,
} from '@server/api/readerDelivery';
import {
  buildReaderGroupingFilter,
  describeReaderGroupingRule,
  ReaderDeliveryApi,
  ReaderServiceError,
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
import logger from '@server/logger';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import {
  getComparableReaderServiceUrl,
  normalizeReaderServiceUrl,
} from '@server/utils/readerServiceUrl';
import {
  isValidApplicationUrl,
  preserveRedactedSecrets,
  REDACTED_SECRET,
  redactSecrets,
} from '@server/utils/security';
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

  return { value: normalizeReaderServiceUrl(trimmed) };
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

const getProviderName = (provider: ReaderGroupingProvider) =>
  provider === 'grimmory' ? 'Grimmory' : 'BookOrbit';

const getGroupingName = (provider: ReaderGroupingProvider) =>
  provider === 'grimmory' ? 'Grimmory Magic Shelf' : 'BookOrbit Smart Scope';

const getStepLabel = (
  provider: ReaderGroupingProvider,
  step: ReaderServiceStep
): string => {
  switch (step) {
    case 'sign-in':
      return 'Signing in to ' + getProviderName(provider);
    case 'list':
      return provider === 'grimmory'
        ? 'Listing Grimmory Magic Shelves'
        : 'Listing BookOrbit Smart Scopes';
    case 'preview':
      return 'Previewing matching ' + getProviderName(provider) + ' books';
    case 'create':
      return 'Creating the ' + getGroupingName(provider);
    case 'update':
      return 'Updating the ' + getGroupingName(provider);
    case 'count':
      return 'Counting the books in the ' + getGroupingName(provider);
    case 'delete':
      return 'Removing the ' + getGroupingName(provider);
  }
};

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const TLS_CODE =
  /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|EPROTO$)/;

const getFailureDetail = (
  error: ReaderServiceError,
  provider: ReaderGroupingProvider
): string => {
  const providerName = getProviderName(provider);
  const { step, reason, status, code } = error;
  const isSignIn = step === 'sign-in';
  const tooLarge =
    providerName +
    ' sent a response that SeerrNG could not read completely or that was too large to process safely.';

  if (
    reason === 'not-api' ||
    (isSignIn && (status === 404 || status === 405))
  ) {
    return provider === 'grimmory'
      ? 'The address did not answer like the Grimmory API. Enter the address you open Grimmory at, including any reverse-proxy base path.'
      : 'The address did not answer like the BookOrbit API. Enter the address you open BookOrbit at. BookOrbit has no base-path setting, so a reverse proxy that serves it under a sub-path must remove that path before forwarding requests.';
  }
  if (reason === 'unexpected') {
    return (
      providerName +
      ' sent a response SeerrNG does not recognize. Check that the address points to ' +
      providerName +
      ' and that ' +
      providerName +
      ' is up to date.'
    );
  }
  if (reason === 'request') {
    return (
      'SeerrNG did not send the request. Check that the ' +
      providerName +
      ' address is a valid http or https address.'
    );
  }
  if (reason === 'network') {
    if (code && TIMEOUT_CODES.has(code)) {
      return (
        providerName +
        ' did not answer in time. Check that it is running and reachable from the SeerrNG server.'
      );
    }
    if (code && TLS_CODE.test(code)) {
      return (
        'SeerrNG could not make a secure connection to ' +
        providerName +
        '. Check whether the address should start with http or https, and that the SeerrNG server trusts its certificate.'
      );
    }
    if (code === 'ERR_BAD_RESPONSE') return tooLarge;
    return (
      'SeerrNG could not reach ' +
      providerName +
      '. Check the address and that ' +
      providerName +
      ' is running and reachable from the SeerrNG server.'
    );
  }

  if (status !== undefined && status >= 300 && status < 400) {
    return (
      'The address redirected the request. Enter the final ' +
      providerName +
      ' address, and let API requests past any sign-in page in front of it.'
    );
  }
  if (status === 401) {
    return isSignIn
      ? providerName +
          ' did not accept the username and password. Check them, and check that the account is active and not locked.'
      : providerName +
          ' did not accept the sign-in on the next request. If a reverse proxy is in front of ' +
          providerName +
          ', make sure it forwards the Authorization header.';
  }
  if (status === 403) {
    if (isSignIn) {
      return provider === 'grimmory'
        ? 'Grimmory refused password sign-in for this account. If Grimmory allows only single sign-on, use a Grimmory administrator account.'
        : 'BookOrbit refused password sign-in for this account. Allow password sign-in in BookOrbit, or use an account that signs in with a password.';
    }
    return provider === 'grimmory'
      ? 'Grimmory refused this account access to Magic Shelves. Use a Grimmory administrator account.'
      : 'BookOrbit refused this account access to Smart Scopes. Sign in to BookOrbit with it once to replace any temporary password. To change a Smart Scope, use the BookOrbit account that created it.';
  }
  if (status === 404 || status === 405) {
    if (step === 'list' || step === 'preview' || step === 'create') {
      return (
        providerName +
        ' does not offer the ' +
        (provider === 'grimmory' ? 'Magic Shelf' : 'Smart Scope') +
        ' API at this address. Update ' +
        providerName +
        ', and make sure any reverse proxy forwards every /api path.'
      );
    }
    return (
      providerName +
      ' could not find the ' +
      getGroupingName(provider) +
      '. If it was removed in ' +
      providerName +
      ', remove the SeerrNG-managed shelf and create it again. If not, update ' +
      providerName +
      ', and make sure any reverse proxy forwards every /api path.'
    );
  }
  if (status === 413) return tooLarge;
  if (status === 429) {
    return (
      providerName +
      ' is limiting requests from SeerrNG. Wait a minute and try again.'
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return (
      providerName +
      ' or a proxy in front of it is unavailable (HTTP ' +
      status +
      '). Check that ' +
      providerName +
      ' is running.'
    );
  }
  if (status !== undefined && status >= 500) {
    return (
      providerName +
      ' reported an internal error (HTTP ' +
      status +
      '). Check the ' +
      providerName +
      ' logs.'
    );
  }
  if (isSignIn && status === 400) {
    return (
      providerName +
      ' did not accept the sign-in request. Check the username and password.'
    );
  }
  return (
    providerName +
    ' refused the request (HTTP ' +
    status +
    '). Check that ' +
    providerName +
    ' is up to date.'
  );
};

/**
 * Builds the user-facing message for a failed reader-service call. Only the
 * provider, step, status, and error code are logged, never response text.
 */
const getProviderError = (
  error: unknown,
  provider: ReaderGroupingProvider
): string => {
  if (!(error instanceof ReaderServiceError)) {
    logger.warn('Reader service request failed.', {
      label: 'Reader Delivery',
      provider,
    });
    return (
      'SeerrNG could not complete the request to ' +
      getProviderName(provider) +
      '. Check the service address and try again.'
    );
  }
  logger.warn('Reader service request failed.', {
    label: 'Reader Delivery',
    provider,
    step: error.step,
    reason: error.reason,
    status: error.status,
    code: error.code,
  });
  return (
    getStepLabel(provider, error.step) +
    ' failed. ' +
    getFailureDetail(error, provider)
  );
};

/**
 * Decides what a submitted password stands for. A blank or redacted password
 * means the saved one, but only for the saved address and username, so the
 * saved credential is never sent to a different service or account.
 */
const getSavedPasswordUse = (
  saved: ReturnType<typeof getProviderConfig>,
  url: string,
  username: string,
  password: string
): 'typed' | 'saved' | 'none' | 'changed' => {
  if (password && password !== REDACTED_SECRET) return 'typed';
  if (!saved.password) return 'none';
  return saved.url &&
    getComparableReaderServiceUrl(url) ===
      getComparableReaderServiceUrl(saved.url) &&
    username === saved.username
    ? 'saved'
    : 'changed';
};

/**
 * The password Save stores. A password is kept only with an address and
 * username, since it could never be used without them.
 */
const getPasswordToSave = (
  provider: ReaderGroupingProvider,
  saved: ReturnType<typeof getProviderConfig>,
  url: string,
  username: string,
  password: string
): { value: string } | { error: string } => {
  if (!url || !username) return { value: '' };
  const use = getSavedPasswordUse(saved, url, username, password);
  if (use === 'typed') return { value: password };
  if (use === 'saved') return { value: saved.password };
  if (use === 'changed') {
    return {
      error:
        'Enter the ' +
        getProviderName(provider) +
        ' password again to save a changed address or username.',
    };
  }
  return { value: '' };
};

/**
 * Reads the address and account a connection test should use. Fields left
 * out fall back to the saved settings, and the password follows the same
 * rule as Save.
 */
const getConnectionTestConfig = (
  provider: ReaderGroupingProvider,
  body: Record<string, unknown>,
  settings: ReaderDeliverySettings
): { config: ReturnType<typeof getProviderConfig> } | { error: string } => {
  const providerName = getProviderName(provider);
  const saved = getProviderConfig(provider, settings);
  const url =
    body.url === undefined
      ? { value: saved.url }
      : parseServiceUrl(body.url, providerName + ' URL');
  if ('error' in url) return url;
  if (!url.value) {
    return {
      error: 'Enter the ' + providerName + ' address to test the connection.',
    };
  }
  const username =
    body.username === undefined
      ? { value: saved.username }
      : parseCredentialText(body.username, providerName + ' username', 256);
  if ('error' in username) return username;
  if (!username.value) {
    return {
      error: 'Enter the ' + providerName + ' username to test the connection.',
    };
  }
  const password =
    body.password === undefined
      ? { value: '' }
      : parseCredentialText(
          body.password,
          providerName + ' password',
          2048,
          false
        );
  if ('error' in password) return password;
  const use = getSavedPasswordUse(
    saved,
    url.value,
    username.value,
    password.value
  );
  if (use === 'none') {
    return {
      error: 'Enter the ' + providerName + ' password to test the connection.',
    };
  }
  if (use === 'changed') {
    return {
      error:
        'Enter the ' +
        providerName +
        ' password again to test a changed address or username.',
    };
  }
  return {
    config: {
      url: url.value,
      username: username.value,
      password: use === 'typed' ? password.value : saved.password,
    },
  };
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
    // An omitted password keeps the saved one, like the redacted marker.
    const grimmoryPassword = parseCredentialText(
      req.body.grimmoryPassword ?? REDACTED_SECRET,
      'Grimmory password',
      2048,
      false
    );
    const bookorbitPassword = parseCredentialText(
      req.body.bookorbitPassword ?? REDACTED_SECRET,
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
    const grimmorySecret = clearGrimmoryCredentials
      ? { value: '' }
      : getPasswordToSave(
          'grimmory',
          getProviderConfig('grimmory', current),
          grimmoryUrl.value,
          grimmoryUsername.value,
          grimmoryPassword.value
        );
    if ('error' in grimmorySecret)
      return res.status(400).json({ error: grimmorySecret.error });
    const bookorbitSecret = clearBookorbitCredentials
      ? { value: '' }
      : getPasswordToSave(
          'bookorbit',
          getProviderConfig('bookorbit', current),
          bookorbitUrl.value,
          bookorbitUsername.value,
          bookorbitPassword.value
        );
    if ('error' in bookorbitSecret)
      return res.status(400).json({ error: bookorbitSecret.error });

    const candidate: ReaderDeliverySettings = {
      grimmoryUrl: grimmoryUrl.value,
      grimmoryUsername: clearGrimmoryCredentials ? '' : grimmoryUsername.value,
      grimmoryPassword: grimmorySecret.value,
      bookorbitUrl: bookorbitUrl.value,
      bookorbitUsername: clearBookorbitCredentials
        ? ''
        : bookorbitUsername.value,
      bookorbitPassword: bookorbitSecret.value,
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
    const body = isRecord(req.body) ? req.body : {};
    const provider = parseProvider(body.provider);
    if (!provider) {
      return res.status(400).json({ error: 'Choose Grimmory or BookOrbit.' });
    }
    const settings =
      getSettings().readerDelivery ?? defaultReaderDeliverySettings();
    const tested = getConnectionTestConfig(provider, body, settings);
    if ('error' in tested) return res.status(400).json(tested);
    try {
      const api = new ReaderDeliveryApi(tested.config.url);
      const token = await api.login(provider, tested.config);
      const groupings = await api.listGroupings(provider, token);
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
          'SeerrNG sets a BookOrbit Smart Scope’s visibility only when it creates the Smart Scope. Change this Smart Scope’s visibility in BookOrbit, or remove the SeerrNG-managed Smart Scope and create it again.',
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
      } catch (error) {
        warning =
          'The ' +
          getGroupingName(provider) +
          ' was saved, but SeerrNG could not confirm its final item count. ' +
          getProviderError(error, provider) +
          ' Open ' +
          getProviderName(provider) +
          ' and refresh this grouping to check it.';
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
        // A grouping already removed in the reader service counts as removed.
        const alreadyRemoved =
          error instanceof ReaderServiceError &&
          error.step === 'delete' &&
          error.status === 404;
        if (!alreadyRemoved) {
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
