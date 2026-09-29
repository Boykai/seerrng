import MylarAPI from '@server/api/comics/mylar';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { Permission } from '@server/lib/permissions';
import { runWithComicServiceCollectionMutationAdmission } from '@server/lib/serviceAdmission';
import {
  allocateServarrServiceId,
  assertServarrServiceCanBeRemoved,
  getHistoricalComicServiceIdMaximum,
} from '@server/lib/serviceId';
import type { MylarSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import { parseNonNegativeRouteId } from '@server/utils/routeId';
import { REDACTED_SECRET, redactSecrets } from '@server/utils/security';
import {
  assertServarrInstanceCapacity,
  parseMylarSettings,
  parseServarrConnectionSettings,
  preserveServarrApiKey,
  preserveServarrConnectionSecret,
  type ServarrConnectionSettings,
} from '@server/utils/servarrSettings';
import { Router } from 'express';

const mylarRoutes = Router();

mylarRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(redactSecrets(settings.mylar));
});

mylarRoutes.post(
  '/',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const settings = getSettings();

    const parsedMylar = parseMylarSettings(req.body);

    if ('error' in parsedMylar) {
      return res.status(400).json({ message: parsedMylar.error });
    }

    return runWithComicServiceCollectionMutationAdmission(async () => {
      const historicalServiceIdMaximum =
        await getHistoricalComicServiceIdMaximum();
      const mylar = await settings.persistSection('mylar', (current) => {
        assertServarrInstanceCapacity(current);
        const newMylar = {
          ...parsedMylar.value,
          id: allocateServarrServiceId(
            [
              ...current.map(({ id }) => id),
              ...settings.kapowarr.map(({ id }) => id),
              ...settings.backissue.map(({ id }) => id),
            ],
            historicalServiceIdMaximum
          ),
        };
        const existing = newMylar.isDefault
          ? current.map((instance) => ({ ...instance, isDefault: false }))
          : current;
        return [...existing, newMylar];
      });
      if (parsedMylar.value.isDefault) {
        await Promise.all([
          settings.persistSection('kapowarr', (current) =>
            current.map((instance) => ({ ...instance, isDefault: false }))
          ),
          settings.persistSection('backissue', (current) =>
            current.map((instance) => ({ ...instance, isDefault: false }))
          ),
        ]);
      }
      const newMylar = mylar[mylar.length - 1];

      return res.status(201).json(redactSecrets(newMylar));
    });
  })
);

mylarRoutes.post<undefined, Record<string, unknown>, ServarrConnectionSettings>(
  '/test',
  authorizedMutation<
    undefined,
    Record<string, unknown>,
    ServarrConnectionSettings
  >(Permission.ADMIN, async (req, res, next) => {
    try {
      const parsedMylar = parseServarrConnectionSettings(
        preserveServarrConnectionSecret(
          req.body,
          getExternalRuntimeConfig().mylar
        )
      );

      if ('error' in parsedMylar) {
        return res.status(400).json({ message: parsedMylar.error });
      }

      const mylar = new MylarAPI({
        apiKey: parsedMylar.value.apiKey,
        url: MylarAPI.buildUrl(parsedMylar.value),
      });

      const version = await mylar.getVersion();

      return res.status(200).json({ version: version.current_version });
    } catch (e) {
      logger.error('Failed to test Mylar', {
        label: 'Mylar',
        message: e.message,
      });

      next({ status: 500, message: 'Failed to connect to Mylar' });
    }
  })
);

mylarRoutes.put<{ id: string }, MylarSettings, MylarSettings>(
  '/:id',
  authorizedMutation<{ id: string }, MylarSettings, MylarSettings>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const mylarId = parseNonNegativeRouteId(req.params.id);
      if (mylarId === undefined) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      const mylarIndex = settings.mylar.findIndex((m) => m.id === mylarId);

      if (mylarIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      return runWithComicServiceCollectionMutationAdmission(async () => {
        const currentMylar = settings.mylar.find(
          (instance) => instance.id === mylarId
        );
        if (!currentMylar) {
          return next({ status: 404, message: 'Settings instance not found' });
        }
        const admittedMylar = parseMylarSettings(
          preserveServarrApiKey(req.body, currentMylar),
          currentMylar
        );
        if ('error' in admittedMylar) {
          return next({ status: 400, message: admittedMylar.error });
        }
        const mylar = await settings.persistSection('mylar', (current) =>
          current.map((instance) => {
            if (instance.id === mylarId) {
              return {
                ...admittedMylar.value,
                apiKey:
                  (req.body as { apiKey?: unknown }).apiKey === REDACTED_SECRET
                    ? instance.apiKey
                    : admittedMylar.value.apiKey,
                id: mylarId,
              } as MylarSettings;
            }
            return admittedMylar.value.isDefault
              ? { ...instance, isDefault: false }
              : instance;
          })
        );
        if (admittedMylar.value.isDefault) {
          await Promise.all([
            settings.persistSection('kapowarr', (current) =>
              current.map((instance) => ({ ...instance, isDefault: false }))
            ),
            settings.persistSection('backissue', (current) =>
              current.map((instance) => ({ ...instance, isDefault: false }))
            ),
          ]);
        }

        return res
          .status(200)
          .json(redactSecrets(mylar.find(({ id }) => id === mylarId)));
      });
    }
  )
);

mylarRoutes.delete<{ id: string }>(
  '/:id',
  authorizedMutation<{ id: string }>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const mylarId = parseNonNegativeRouteId(req.params.id);
      if (mylarId === undefined) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      const mylarIndex = settings.mylar.findIndex((m) => m.id === mylarId);

      if (mylarIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      return runWithComicServiceCollectionMutationAdmission(async () => {
        const removed = settings.mylar.find(
          (instance) => instance.id === mylarId
        );
        if (!removed) {
          return next({ status: 404, message: 'Settings instance not found' });
        }
        await assertServarrServiceCanBeRemoved('mylar', mylarId);
        await settings.persistSection('mylar', (current) =>
          current.filter(({ id }) => id !== mylarId)
        );

        return res.status(200).json(redactSecrets(removed));
      });
    }
  )
);

export default mylarRoutes;
