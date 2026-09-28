import {
  AnilistAuthError,
  AnilistRateLimitedError,
} from '@server/api/anilist/failures';
import {
  MdblistListNotFoundError,
  MdblistNotConfiguredError,
  MdblistQuotaExceededError,
} from '@server/api/mdblist';
import {
  SimklRateLimitedError,
  SimklUnauthorizedError,
} from '@server/api/simkl';
import {
  TraktRateLimitedError,
  TraktReconnectRequiredError,
  TraktRefreshRejectedError,
} from '@server/api/trakt';
import { Permission } from '@server/lib/permissions';
import {
  UserMutationActorUnauthorizedError,
  runUserSecurityMutationWithActor,
} from '@server/lib/userSecurityMutation';
import type { Request, RequestHandler } from 'express';
import { DiscoveryIntegrationError } from './accounts';

export const handleDiscoveryIntegration =
  (callback: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await callback(req, res, next);
    } catch (error) {
      if (
        error instanceof TraktRateLimitedError ||
        error instanceof SimklRateLimitedError ||
        error instanceof AnilistRateLimitedError
      ) {
        res.set(
          'Retry-After',
          String(Math.max(1, Math.min(3600, error.retryAfterSeconds || 60)))
        );
        return res.status(429).json({
          code: 'PROVIDER_RATE_LIMITED',
          message: 'The provider request limit was reached. Try again later.',
        });
      }
      if (
        error instanceof TraktReconnectRequiredError ||
        error instanceof TraktRefreshRejectedError ||
        error instanceof SimklUnauthorizedError ||
        error instanceof AnilistAuthError
      )
        return res.status(409).json({
          code: 'RECONNECT_REQUIRED',
          message: 'Reconnect your provider account under Linked Accounts.',
        });
      if (error instanceof MdblistNotConfiguredError)
        return res.status(409).json({
          code: 'PROVIDER_SETUP_REQUIRED',
          message:
            'Ask your administrator to configure MDBList in Discovery Integrations.',
        });
      if (error instanceof MdblistListNotFoundError)
        return res.status(404).json({
          code: 'PROVIDER_LIST_NOT_FOUND',
          message:
            'MDBList could not find that list. Check whether its URL or ID is correct and the list is public.',
        });
      if (error instanceof MdblistQuotaExceededError) {
        res.set(
          'Retry-After',
          String(Math.max(1, Math.min(3600, error.retryAfterSeconds)))
        );
        return res.status(429).json({
          code: 'PROVIDER_RATE_LIMITED',
          message: 'The provider request limit was reached. Try again later.',
        });
      }
      if (error instanceof UserMutationActorUnauthorizedError)
        return res
          .status(403)
          .json({ message: 'Sign in again before managing accounts.' });
      if (error instanceof DiscoveryIntegrationError)
        return res.status(error.status).json({ message: error.message });
      return res.status(502).json({
        code: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
        message:
          'The account provider could not complete this operation. Try again shortly.',
      });
    }
  };

// Linking and account changes require the user's browser session, never an app API key.
export function requireDiscoveryBrowserSession(req: Request) {
  if (!req.user || req.session?.userId !== req.user.id)
    throw new DiscoveryIntegrationError(
      403,
      'Sign in to manage personal accounts.'
    );
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  let foreignOrigin: boolean;
  try {
    foreignOrigin = !!origin && new URL(origin).host !== req.get('host');
  } catch {
    foreignOrigin = true;
  }
  if (site === 'cross-site' || foreignOrigin) {
    throw new DiscoveryIntegrationError(
      403,
      'Account changes must originate from SeerrNG.'
    );
  }
}
export function runPersonalDiscoveryMutation<T>(
  req: Request,
  callback: () => Promise<T>
) {
  requireDiscoveryBrowserSession(req);
  return runUserSecurityMutationWithActor(
    req.user!.id,
    req.user!.id,
    Permission.ADMIN,
    callback
  );
}
