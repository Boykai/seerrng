import type {
  SuwayomiSettingsErrorCode,
  SuwayomiSettingsErrorResponse,
} from '@server/interfaces/api/suwayomiInterfaces';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { Permission } from '@server/lib/permissions';
import { runWithServarrServiceCollectionMutationAdmission } from '@server/lib/serviceAdmission';
import {
  allocateServarrServiceId,
  assertServarrServiceCanBeRemoved,
  getHistoricalServarrServiceIdMaximum,
  ServarrServiceInUseError,
} from '@server/lib/serviceId';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { runSuwayomiConnectionTest } from '@server/lib/suwayomi/connectionTest';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import { parseNonNegativeRouteId } from '@server/utils/routeId';
import {
  checkSuwayomiCredentials,
  MAX_SUWAYOMI_INSTANCES,
  parseSuwayomiConnectionTest,
  parseSuwayomiSettings,
  resolveSuwayomiPassword,
  SUWAYOMI_SETTINGS_MESSAGES,
  suwayomiSettingsView,
} from '@server/utils/suwayomiSettings';
import type { Response } from 'express';
import { Router } from 'express';

const NOT_FOUND = { status: 404, message: 'Settings instance not found' };

class SuwayomiSettingsRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: SuwayomiSettingsErrorCode,
    message: string
  ) {
    super(message);
  }
}

class SuwayomiInstanceMissingError extends Error {}

const sendError = (
  res: Response,
  status: number,
  { code, error }: { code: SuwayomiSettingsErrorCode; error: string }
) =>
  res
    .status(status)
    .json({ code, message: error } satisfies SuwayomiSettingsErrorResponse);

const sendRouteError = (res: Response, error: unknown): boolean => {
  if (error instanceof SuwayomiSettingsRouteError) {
    sendError(res, error.status, { code: error.code, error: error.message });
    return true;
  }
  if (error instanceof ServarrServiceInUseError) {
    sendError(res, 409, { code: 'SUWAYOMI_IN_USE', error: error.message });
    return true;
  }
  return false;
};

const suwayomiRoutes = Router();

suwayomiRoutes.get('/', (_req, res) => {
  res.status(200).json(getSettings().suwayomi.map(suwayomiSettingsView));
});

suwayomiRoutes.post(
  '/',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const parsed = parseSuwayomiSettings(req.body);
    if ('error' in parsed) {
      return sendError(res, 400, parsed);
    }
    // A new instance has no stored password for `[REDACTED]` to stand for.
    const password = resolveSuwayomiPassword(parsed.value, undefined);
    if ('error' in password) {
      return sendError(res, 400, password);
    }

    const settings = getSettings();
    try {
      const created = await runWithServarrServiceCollectionMutationAdmission(
        'suwayomi',
        async () => {
          const historicalMaximum =
            await getHistoricalServarrServiceIdMaximum('suwayomi');
          const saved = await settings.persistSection('suwayomi', (current) => {
            if (current.length >= MAX_SUWAYOMI_INSTANCES) {
              throw new SuwayomiSettingsRouteError(
                409,
                'SUWAYOMI_INSTANCE_LIMIT',
                SUWAYOMI_SETTINGS_MESSAGES.SUWAYOMI_INSTANCE_LIMIT
              );
            }
            const instance: SuwayomiSettings = {
              ...parsed.value,
              id: allocateServarrServiceId(
                current.map(({ id }) => id),
                historicalMaximum
              ),
              isDefault: true,
            };
            return [...current, instance];
          });
          return saved[saved.length - 1];
        }
      );
      invalidateSuwayomiClients(created.id);
      return res.status(201).json(suwayomiSettingsView(created));
    } catch (error) {
      if (sendRouteError(res, error)) return;
      throw error;
    }
  })
);

suwayomiRoutes.post(
  '/test',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const parsed = parseSuwayomiConnectionTest(req.body);
    if ('error' in parsed) {
      return sendError(res, 400, parsed);
    }
    const stored =
      parsed.value.id === undefined
        ? undefined
        : getExternalRuntimeConfig().suwayomi.find(
            ({ id }) => id === parsed.value.id
          );
    const password = resolveSuwayomiPassword(parsed.value, stored);
    if ('error' in password) {
      return sendError(res, 400, password);
    }

    // Stops talking to Suwayomi when the admin abandons the test.
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    };
    res.once('close', cancel);
    try {
      const result = await runSuwayomiConnectionTest(
        { ...parsed.value, password: password.value },
        { signal: controller.signal }
      );
      return res.status(result.success ? 200 : 502).json(result);
    } finally {
      res.off('close', cancel);
    }
  })
);

suwayomiRoutes.put<{ id: string }>(
  '/:id',
  authorizedMutation<{ id: string }>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const suwayomiId = parseNonNegativeRouteId(req.params.id);
      if (
        suwayomiId === undefined ||
        !settings.suwayomi.some(({ id }) => id === suwayomiId)
      ) {
        return next(NOT_FOUND);
      }
      const parsed = parseSuwayomiSettings(req.body);
      if ('error' in parsed) {
        return sendError(res, 400, parsed);
      }

      try {
        const updated = await runWithServarrServiceCollectionMutationAdmission(
          'suwayomi',
          async () => {
            const saved = await settings.persistSection(
              'suwayomi',
              (current) => {
                const stored = current.find(({ id }) => id === suwayomiId);
                if (!stored) {
                  throw new SuwayomiInstanceMissingError();
                }
                const password = resolveSuwayomiPassword(parsed.value, stored);
                if ('error' in password) {
                  throw new SuwayomiSettingsRouteError(
                    400,
                    password.code,
                    password.error
                  );
                }
                const missingCredentials = checkSuwayomiCredentials(
                  parsed.value.authMode,
                  parsed.value.username,
                  password.value
                );
                if (missingCredentials) {
                  throw new SuwayomiSettingsRouteError(
                    400,
                    missingCredentials.code,
                    missingCredentials.error
                  );
                }
                return current.map((instance) =>
                  instance.id === suwayomiId
                    ? {
                        // Keeps fields that later versions add and this
                        // request doesn't carry.
                        ...instance,
                        ...parsed.value,
                        password: password.value,
                        id: suwayomiId,
                        isDefault: instance.isDefault,
                      }
                    : instance
                );
              }
            );
            return saved.find(({ id }) => id === suwayomiId);
          }
        );
        invalidateSuwayomiClients(suwayomiId);
        if (!updated) {
          return next(NOT_FOUND);
        }
        return res.status(200).json(suwayomiSettingsView(updated));
      } catch (error) {
        if (error instanceof SuwayomiInstanceMissingError) {
          return next(NOT_FOUND);
        }
        if (sendRouteError(res, error)) return;
        throw error;
      }
    }
  )
);

suwayomiRoutes.delete<{ id: string }>(
  '/:id',
  authorizedMutation<{ id: string }>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const suwayomiId = parseNonNegativeRouteId(req.params.id);
      if (
        suwayomiId === undefined ||
        !settings.suwayomi.some(({ id }) => id === suwayomiId)
      ) {
        return next(NOT_FOUND);
      }

      try {
        const removed = await runWithServarrServiceCollectionMutationAdmission(
          'suwayomi',
          async () => {
            await assertServarrServiceCanBeRemoved('suwayomi', suwayomiId);
            let instance: SuwayomiSettings | undefined;
            await settings.persistSection('suwayomi', (current) => {
              instance = current.find(({ id }) => id === suwayomiId);
              if (!instance) {
                throw new SuwayomiInstanceMissingError();
              }
              return current.filter(({ id }) => id !== suwayomiId);
            });
            return instance as SuwayomiSettings;
          }
        );
        invalidateSuwayomiClients(suwayomiId);
        return res.status(200).json(suwayomiSettingsView(removed));
      } catch (error) {
        if (error instanceof SuwayomiInstanceMissingError) {
          return next(NOT_FOUND);
        }
        if (sendRouteError(res, error)) return;
        throw error;
      }
    }
  )
);

export default suwayomiRoutes;
