import KapowarrAPI from '@server/api/comics/kapowarr';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { Permission } from '@server/lib/permissions';
import { runWithComicServiceCollectionMutationAdmission } from '@server/lib/serviceAdmission';
import {
  allocateServarrServiceId,
  assertServarrServiceCanBeRemoved,
  getHistoricalComicServiceIdMaximum,
} from '@server/lib/serviceId';
import type { KapowarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import { parseNonNegativeRouteId } from '@server/utils/routeId';
import { REDACTED_SECRET, redactSecrets } from '@server/utils/security';
import {
  assertServarrInstanceCapacity,
  parseKapowarrSettings,
  parseServarrConnectionSettings,
  preserveServarrApiKey,
  preserveServarrConnectionSecret,
  type ServarrConnectionSettings,
} from '@server/utils/servarrSettings';
import { Router } from 'express';

const kapowarrRoutes = Router();

kapowarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(redactSecrets(settings.kapowarr));
});

kapowarrRoutes.post(
  '/',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    const settings = getSettings();

    const parsedKapowarr = parseKapowarrSettings(req.body);

    if ('error' in parsedKapowarr) {
      return res.status(400).json({ message: parsedKapowarr.error });
    }

    return runWithComicServiceCollectionMutationAdmission(async () => {
      const historicalServiceIdMaximum =
        await getHistoricalComicServiceIdMaximum();
      const kapowarr = await settings.persistSection('kapowarr', (current) => {
        assertServarrInstanceCapacity(current);
        const newKapowarr = {
          ...parsedKapowarr.value,
          id: allocateServarrServiceId(
            [
              ...current.map(({ id }) => id),
              ...settings.mylar.map(({ id }) => id),
              ...settings.backissue.map(({ id }) => id),
            ],
            historicalServiceIdMaximum
          ),
        };
        const existing = newKapowarr.isDefault
          ? current.map((instance) => ({ ...instance, isDefault: false }))
          : current;
        return [...existing, newKapowarr];
      });
      if (parsedKapowarr.value.isDefault) {
        await Promise.all([
          settings.persistSection('mylar', (current) =>
            current.map((instance) => ({ ...instance, isDefault: false }))
          ),
          settings.persistSection('backissue', (current) =>
            current.map((instance) => ({ ...instance, isDefault: false }))
          ),
        ]);
      }
      const newKapowarr = kapowarr[kapowarr.length - 1];

      return res.status(201).json(redactSecrets(newKapowarr));
    });
  })
);

kapowarrRoutes.post<
  undefined,
  Record<string, unknown>,
  ServarrConnectionSettings
>(
  '/test',
  authorizedMutation<
    undefined,
    Record<string, unknown>,
    ServarrConnectionSettings
  >(Permission.ADMIN, async (req, res, next) => {
    try {
      const parsedKapowarr = parseServarrConnectionSettings(
        preserveServarrConnectionSecret(
          req.body,
          getExternalRuntimeConfig().kapowarr
        )
      );

      if ('error' in parsedKapowarr) {
        return res.status(400).json({ message: parsedKapowarr.error });
      }

      const kapowarr = new KapowarrAPI({
        apiKey: parsedKapowarr.value.apiKey,
        url: KapowarrAPI.buildUrl(parsedKapowarr.value),
      });

      const about = await kapowarr.getSystemAbout();
      const rootFolders = await kapowarr.getRootFolders();

      return res.status(200).json({
        version: about.version,
        rootFolders: rootFolders.map((folder) => ({
          id: folder.id,
          path: folder.folder,
        })),
      });
    } catch (e) {
      logger.error('Failed to test Kapowarr', {
        label: 'Kapowarr',
        message: e.message,
      });

      next({ status: 500, message: 'Failed to connect to Kapowarr' });
    }
  })
);

kapowarrRoutes.put<{ id: string }, KapowarrSettings, KapowarrSettings>(
  '/:id',
  authorizedMutation<{ id: string }, KapowarrSettings, KapowarrSettings>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const kapowarrId = parseNonNegativeRouteId(req.params.id);
      if (kapowarrId === undefined) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      const kapowarrIndex = settings.kapowarr.findIndex(
        (k) => k.id === kapowarrId
      );

      if (kapowarrIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      return runWithComicServiceCollectionMutationAdmission(async () => {
        const currentKapowarr = settings.kapowarr.find(
          (instance) => instance.id === kapowarrId
        );
        if (!currentKapowarr) {
          return next({ status: 404, message: 'Settings instance not found' });
        }
        const admittedKapowarr = parseKapowarrSettings(
          preserveServarrApiKey(req.body, currentKapowarr),
          currentKapowarr
        );
        if ('error' in admittedKapowarr) {
          return next({ status: 400, message: admittedKapowarr.error });
        }
        const kapowarr = await settings.persistSection('kapowarr', (current) =>
          current.map((instance) => {
            if (instance.id === kapowarrId) {
              return {
                ...admittedKapowarr.value,
                apiKey:
                  (req.body as { apiKey?: unknown }).apiKey === REDACTED_SECRET
                    ? instance.apiKey
                    : admittedKapowarr.value.apiKey,
                id: kapowarrId,
              } as KapowarrSettings;
            }
            return admittedKapowarr.value.isDefault
              ? { ...instance, isDefault: false }
              : instance;
          })
        );
        if (admittedKapowarr.value.isDefault) {
          await Promise.all([
            settings.persistSection('mylar', (current) =>
              current.map((instance) => ({ ...instance, isDefault: false }))
            ),
            settings.persistSection('backissue', (current) =>
              current.map((instance) => ({ ...instance, isDefault: false }))
            ),
          ]);
        }

        return res
          .status(200)
          .json(redactSecrets(kapowarr.find(({ id }) => id === kapowarrId)));
      });
    }
  )
);

kapowarrRoutes.delete<{ id: string }>(
  '/:id',
  authorizedMutation<{ id: string }>(
    Permission.ADMIN,
    async (req, res, next) => {
      const settings = getSettings();
      const kapowarrId = parseNonNegativeRouteId(req.params.id);
      if (kapowarrId === undefined) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      const kapowarrIndex = settings.kapowarr.findIndex(
        (k) => k.id === kapowarrId
      );

      if (kapowarrIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      return runWithComicServiceCollectionMutationAdmission(async () => {
        const removed = settings.kapowarr.find(
          (instance) => instance.id === kapowarrId
        );
        if (!removed) {
          return next({ status: 404, message: 'Settings instance not found' });
        }
        await assertServarrServiceCanBeRemoved('kapowarr', kapowarrId);
        await settings.persistSection('kapowarr', (current) =>
          current.filter(({ id }) => id !== kapowarrId)
        );

        return res.status(200).json(redactSecrets(removed));
      });
    }
  )
);

export default kapowarrRoutes;
