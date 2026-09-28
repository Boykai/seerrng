import AnilistAPI from '@server/api/anilist';
import SimklAPI from '@server/api/simkl';
import TraktAPI from '@server/api/trakt';
import type { TraktTokenState } from '@server/api/trakt/interfaces';
import { getRepository } from '@server/datasource';
import DiscoveryAccount, {
  type DiscoveryAccountProvider,
} from '@server/entity/DiscoveryAccount';
import { runWithConfigurationAdmission } from '@server/lib/configurationAdmission';
import { getSettings } from '@server/lib/settings';
import { runUserSecurityMutation } from '@server/lib/userSecurityMutation';

export class DiscoveryIntegrationError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function parseDiscoveryProvider(
  value: unknown
): DiscoveryAccountProvider {
  if (value !== 'trakt' && value !== 'anilist' && value !== 'simkl') {
    throw new DiscoveryIntegrationError(400, 'Unknown account provider.');
  }
  return value;
}

export function publicDiscoveryAccount(account: DiscoveryAccount) {
  return {
    provider: account.provider,
    username: account.username,
    providerUserId: account.providerUserId,
    allowWrites: account.allowWrites,
    linkedAt: account.linkedAt,
    expiresAt: account.expiresAt,
  };
}

export async function getDiscoveryAccount(
  userId: number,
  provider: DiscoveryAccountProvider
) {
  return getRepository(DiscoveryAccount)
    .createQueryBuilder('account')
    .addSelect(['account.accessToken', 'account.refreshToken'])
    .where('account.userId = :userId AND account.provider = :provider', {
      userId,
      provider,
    })
    .getOne();
}

export async function saveDiscoveryAccount(
  userId: number,
  provider: DiscoveryAccountProvider,
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number },
  identity: { username: string; providerUserId: string }
) {
  if (!tokens.accessToken || tokens.accessToken.length > 16384) {
    throw new DiscoveryIntegrationError(
      502,
      'Provider returned an invalid account credential.'
    );
  }
  const repository = getRepository(DiscoveryAccount);
  const previous = await repository.findOneBy({ userId, provider });
  const account = repository.create({
    userId,
    provider,
    clientId: getSettings().discoveryIntegrations[provider].clientId,
    ...tokens,
    refreshToken: tokens.refreshToken ?? null,
    expiresAt: tokens.expiresAt ?? null,
    ...identity,
    allowWrites: false,
    linkedAt: new Date(),
    ...(previous ? { id: previous.id } : {}),
  });
  return repository.save(account);
}

export async function requireDiscoveryAccount(
  userId: number,
  provider: DiscoveryAccountProvider
) {
  const account = await getDiscoveryAccount(userId, provider);
  if (
    !account ||
    account.clientId !== getSettings().discoveryIntegrations[provider].clientId
  ) {
    throw new DiscoveryIntegrationError(
      409,
      `Connect your ${provider} account in profile settings.`
    );
  }
  if (
    provider !== 'trakt' &&
    account.expiresAt &&
    account.expiresAt <= Date.now() / 1000
  ) {
    throw new DiscoveryIntegrationError(
      409,
      `Your ${provider} connection expired. Reconnect in profile settings.`
    );
  }
  return account;
}

export async function getTraktClient(userId: number) {
  const config = getSettings().discoveryIntegrations.trakt;
  const account = await requireDiscoveryAccount(userId, 'trakt');
  return new TraktAPI({
    ...config,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken ?? undefined,
    expiresAt: account.expiresAt ?? 0,
    refreshTokens: (tokens: TraktTokenState) =>
      runUserSecurityMutation(userId, () =>
        runWithConfigurationAdmission('discoveryIntegrations', async () => {
          const current = await requireDiscoveryAccount(userId, 'trakt');
          if (current.clientId !== config.clientId)
            throw new DiscoveryIntegrationError(
              409,
              'Trakt application configuration changed. Reconnect your account.'
            );
          if (
            current.accessToken !== tokens.accessToken &&
            current.expiresAt &&
            current.expiresAt > Date.now() / 1000 + 60
          ) {
            return {
              accessToken: current.accessToken,
              refreshToken: current.refreshToken!,
              expiresAt: current.expiresAt,
            };
          }
          if (!current.refreshToken)
            throw new DiscoveryIntegrationError(
              409,
              'Reconnect your Trakt account.'
            );
          const fresh = await new TraktAPI({
            ...config,
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            expiresAt: current.expiresAt ?? 0,
          }).refreshAccessToken();
          await getRepository(DiscoveryAccount).update(current.id, fresh);
          return fresh;
        })
      ),
  });
}

export async function getAnilistClient(userId: number) {
  const account = await requireDiscoveryAccount(userId, 'anilist');
  return new AnilistAPI({ accessToken: account.accessToken });
}

export async function getSimklClient(userId: number) {
  const account = await requireDiscoveryAccount(userId, 'simkl');
  return new SimklAPI({
    clientId: account.clientId,
    accessToken: account.accessToken,
  });
}
