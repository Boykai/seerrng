import { getRepository } from '@server/datasource';
import QueueIntervention from '@server/entity/QueueIntervention';
import { Permission } from '@server/lib/permissions';
import {
  importIntervention,
  InterventionError,
  previewIntervention,
  projectIntervention,
  refreshInterventions,
  rejectIntervention,
  searchInterventionTargets,
} from '@server/lib/queueInterventions';
import { ServarrServiceAuthorityChangedError } from '@server/lib/serviceAdmission';
import {
  authorizedMutation,
  authorizedRouteScope,
} from '@server/middleware/authorizedMutation';
import { Router } from 'express';
const router = Router();
const identifier = (value: unknown) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value))
    throw new InterventionError(400, 'Invalid warning identifier.');
  return Number(value);
};
const targetIdentifier = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value))
    throw new InterventionError(400, 'Invalid library match identifier.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 2147483647)
    throw new InterventionError(400, 'Invalid library match identifier.');
  return id;
};
const handleError = (error: unknown, next: (error: unknown) => void) => {
  next(
    error instanceof InterventionError
      ? { status: error.status, message: error.message }
      : error instanceof ServarrServiceAuthorityChangedError
        ? {
            status: 409,
            message:
              'The acquisition service configuration changed. Refresh before acting.',
          }
        : {
            status: 502,
            message:
              'The acquisition service could not complete this operation. Refresh to check its current state.',
          }
  );
};
router.use(
  authorizedRouteScope(Permission.MANAGE_DOWNLOADS),
  (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  }
);
router.get('/', async (req, res, next) => {
  try {
    const scope = req.query.scope ?? 'active';
    if (scope !== 'active' && scope !== 'history')
      throw new InterventionError(400, 'Choose active warnings or history.');
    const page =
      req.query.page === undefined ? 1 : identifier(String(req.query.page));
    if (page > 1000)
      throw new InterventionError(400, 'Page exceeds the supported limit.');
    const refresh = await refreshInterventions();
    const query =
      getRepository(QueueIntervention).createQueryBuilder('warning');
    query.where(
      scope === 'history'
        ? "warning.state = 'resolved'"
        : "warning.state != 'resolved'"
    );
    const [items, total] = await query
      .orderBy('warning.lastSeenAt', 'DESC')
      .addOrderBy('warning.id', 'DESC')
      .skip((page - 1) * 25)
      .take(25)
      .getManyAndCount();
    res.json({
      results: items.map(projectIntervention),
      total,
      page,
      ...refresh,
    });
  } catch (error) {
    handleError(error, next);
  }
});
router.get('/:id/targets', async (req, res, next) => {
  try {
    if (typeof req.query.query !== 'string')
      throw new InterventionError(400, 'Enter a library match to search for.');
    if (req.query.query.trim().length < 2 || req.query.query.length > 120)
      throw new InterventionError(
        400,
        'Search with between 2 and 120 characters.'
      );
    res.json(
      await searchInterventionTargets(
        identifier(req.params.id),
        req.query.query
      )
    );
  } catch (error) {
    handleError(error, next);
  }
});
router.get('/:id/preview', async (req, res, next) => {
  try {
    res.json(
      await previewIntervention(
        identifier(req.params.id),
        targetIdentifier(req.query.targetId)
      )
    );
  } catch (error) {
    handleError(error, next);
  }
});
router.post(
  '/:id/reject',
  authorizedMutation(Permission.MANAGE_DOWNLOADS, async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !['blocklist', 'removeFromClient'].includes(key)
        ) ||
        typeof body.blocklist !== 'boolean' ||
        typeof body.removeFromClient !== 'boolean'
      )
        throw new InterventionError(
          400,
          'Choose whether to blocklist and remove the download from its client.'
        );
      res.json(
        await rejectIntervention(
          identifier(req.params.id),
          req.user!.id,
          body.blocklist,
          body.removeFromClient
        )
      );
    } catch (error) {
      handleError(error, next);
    }
  })
);
router.post(
  '/:id/import',
  authorizedMutation(Permission.MANAGE_DOWNLOADS, async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) =>
            !['candidateIds', 'importMode', 'fingerprint', 'targetId'].includes(
              key
            )
        ) ||
        !Array.isArray(body.candidateIds) ||
        typeof body.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.fingerprint) ||
        (body.importMode !== 'copy' && body.importMode !== 'move') ||
        (body.targetId !== undefined &&
          (typeof body.targetId !== 'number' ||
            !Number.isSafeInteger(body.targetId) ||
            body.targetId <= 0 ||
            body.targetId > 2147483647))
      )
        throw new InterventionError(400, 'Select files and an import mode.');
      res.json(
        await importIntervention(
          identifier(req.params.id),
          req.user!.id,
          body.candidateIds,
          body.importMode as 'copy' | 'move',
          body.fingerprint,
          body.targetId as number | undefined
        )
      );
    } catch (error) {
      handleError(error, next);
    }
  })
);
export default router;
