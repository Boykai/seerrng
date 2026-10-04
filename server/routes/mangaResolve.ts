import { HAS_CONTROL_CHARACTER } from '@server/api/suwayomi/mappers';
import { MangaResolutionStatus } from '@server/entity/MangaSourceResolution';
import type {
  MangaResolveBindResponse,
  MangaResolveErrorResponse,
  MangaResolveSearchResponse,
} from '@server/interfaces/api/mangaResolveInterfaces';
import { isTrackedJobRunning, scheduledJobs } from '@server/job/schedule';
import { MangaResolveError } from '@server/lib/mangaResolver/errors';
import {
  getMangaResolveDetail,
  listMangaResolveTitles,
  prepareMangaResolveBind,
  prepareMangaResolveSelect,
  requestMangaResolveSearch,
} from '@server/lib/mangaResolver/review';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import { MAX_PAGINATION_OFFSET } from '@server/utils/pagination';
import { parsePositiveRouteId } from '@server/utils/routeId';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

const MAX_INT32 = 2_147_483_647;
const MAX_LONG = 9_223_372_036_854_775_807n;
export const MANGA_SOURCE_RESOLVE_JOB_ID = 'manga-source-resolve';

/** Query values arrive as strings; only plain digits become numbers. */
const fromDigits = (schema: z.ZodNumber) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    schema
  );

const instanceId = z.number().int().min(0).max(MAX_INT32);
const positiveId = z.number().int().min(1).max(MAX_INT32);
const sourceId = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine((value) => BigInt(value) <= MAX_LONG);
const url = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !HAS_CONTROL_CHARACTER.test(value));

const listQuery = z
  .object({
    take: fromDigits(z.number().int().min(1).max(100)).default(20),
    skip: fromDigits(
      z.number().int().min(0).max(MAX_PAGINATION_OFFSET)
    ).default(0),
    // The list holds only waiting titles, so none is BOUND.
    status: z
      .enum([
        MangaResolutionStatus.QUEUED,
        MangaResolutionStatus.NEEDS_PICK,
        MangaResolutionStatus.NO_MATCH,
        MangaResolutionStatus.EXCLUDED,
        'AWAITING_APPROVAL',
      ])
      .optional(),
  })
  .strict();
const detailQuery = z.object({ instanceId: fromDigits(instanceId) }).strict();
const searchBody = z.object({ instanceId }).strict();
const selectBody = z.object({ instanceId, candidateId: positiveId }).strict();
const bindBody = z.union([
  z.object({ instanceId, suwayomiMangaId: positiveId }).strict(),
  z.object({ instanceId, sourceId, url }).strict(),
]);

const sendError = (res: Response, error: MangaResolveError) =>
  res.status(error.status).json({
    code: error.code,
    message: error.message,
    ...(error.suwayomiCode && { suwayomiCode: error.suwayomiCode }),
  } satisfies MangaResolveErrorResponse);

const invalidRequest = () => new MangaResolveError('MANGA_INVALID_REQUEST');

const anilistIdOf = (req: Request): number => {
  const anilistId = parsePositiveRouteId(req.params.anilistId, MAX_INT32);
  if (anilistId === undefined) throw invalidRequest();
  return anilistId;
};

/**
 * Starts the resolver unless a run is going, in which case that run or the
 * next one takes the title. Like "Run now", this works while the schedule is
 * off.
 */
const startResolverRun = (): boolean => {
  const job = scheduledJobs.find(
    ({ id }) => id === MANGA_SOURCE_RESOLVE_JOB_ID
  );
  if (!job || job.running?.() || isTrackedJobRunning(job.name)) return false;
  try {
    job.job.invoke();
    return true;
  } catch (error) {
    logger.warn('Manga source resolve could not start', {
      label: 'Manga Source Resolve',
      code: error instanceof Error ? error.name : 'UNKNOWN',
    });
    return false;
  }
};

interface Decision {
  signal: AbortSignal;
  apply: () => Promise<MangaResolveBindResponse>;
}

const decisions = new WeakMap<Request, Decision>();

/**
 * Validates the request and makes its Suwayomi reads before any admission is
 * taken, then hands the write to `decide`. Closing the request cancels both.
 */
const prepare =
  (
    read: (req: Request, signal: AbortSignal) => Promise<Decision['apply']>
  ): RequestHandler =>
  async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const apply = await read(req, controller.signal);
      decisions.set(req, { signal: controller.signal, apply });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MangaResolveError) return sendError(res, error);
      throw error;
    }
    if (!controller.signal.aborted) next();
  };

/** Applies a prepared bind under the admin's mutation admission. */
const decide = authorizedMutation(Permission.ADMIN, async (req, res) => {
  const decision = decisions.get(req);
  if (!decision) throw new Error('The source bind was not prepared.');
  if (decision.signal.aborted) return;
  try {
    res.status(200).json(await decision.apply());
  } catch (error) {
    if (error instanceof MangaResolveError) return sendError(res, error);
    throw error;
  }
});

const mangaResolveRoutes = Router();

mangaResolveRoutes.get('/', async (req, res) => {
  const query = listQuery.safeParse(req.query);
  if (!query.success) return sendError(res, invalidRequest());
  return res.status(200).json(await listMangaResolveTitles(query.data));
});

mangaResolveRoutes.get('/:anilistId', async (req, res) => {
  try {
    const anilistId = anilistIdOf(req);
    const query = detailQuery.safeParse(req.query);
    if (!query.success) throw invalidRequest();
    return res
      .status(200)
      .json(await getMangaResolveDetail(query.data.instanceId, anilistId));
  } catch (error) {
    if (error instanceof MangaResolveError) return sendError(res, error);
    throw error;
  }
});

mangaResolveRoutes.post(
  '/:anilistId/search',
  authorizedMutation(Permission.ADMIN, async (req, res) => {
    try {
      const anilistId = anilistIdOf(req);
      const body = searchBody.safeParse(req.body);
      if (!body.success) throw invalidRequest();
      const title = await requestMangaResolveSearch(
        body.data.instanceId,
        anilistId
      );
      return res.status(202).json({
        title,
        runStarted: startResolverRun(),
      } satisfies MangaResolveSearchResponse);
    } catch (error) {
      if (error instanceof MangaResolveError) return sendError(res, error);
      throw error;
    }
  })
);

mangaResolveRoutes.post(
  '/:anilistId/select',
  prepare(async (req, signal) => {
    const anilistId = anilistIdOf(req);
    const body = selectBody.safeParse(req.body);
    if (!body.success) throw invalidRequest();
    return prepareMangaResolveSelect(anilistId, body.data, signal);
  }),
  decide
);

mangaResolveRoutes.post(
  '/:anilistId/bind',
  prepare(async (req, signal) => {
    const anilistId = anilistIdOf(req);
    const body = bindBody.safeParse(req.body);
    if (!body.success) throw invalidRequest();
    return prepareMangaResolveBind(anilistId, body.data, signal);
  }),
  decide
);

export default mangaResolveRoutes;
