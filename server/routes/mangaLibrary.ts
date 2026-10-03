import { HAS_CONTROL_CHARACTER } from '@server/api/suwayomi/mappers';
import {
  MangaBindingConfidence,
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import type {
  MangaLibraryErrorResponse,
  MangaLibraryItemState,
} from '@server/interfaces/api/mangaLibraryInterfaces';
import {
  MangaLibraryError,
  findMangaLibraryCandidate,
  linkMangaLibraryItem,
  listMangaBindings,
  listMangaCandidates,
  readMangaLibraryItem,
  rejectMangaLibraryPair,
} from '@server/lib/mangaLibraryReview';
import { Permission } from '@server/lib/permissions';
import { authorizedMutation } from '@server/middleware/authorizedMutation';
import { MAX_PAGINATION_OFFSET } from '@server/utils/pagination';
import { parsePositiveRouteId } from '@server/utils/routeId';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

const MAX_INT32 = 2_147_483_647;
const MAX_LONG = 9_223_372_036_854_775_807n;

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
const page = {
  take: fromDigits(z.number().int().min(1).max(100)).default(20),
  skip: fromDigits(z.number().int().min(0).max(MAX_PAGINATION_OFFSET)).default(
    0
  ),
};

const candidatesQuery = z
  .object({
    ...page,
    instanceId: fromDigits(instanceId).optional(),
    confidence: z
      .enum([
        MangaBindingConfidence.HIGH,
        MangaBindingConfidence.MEDIUM,
        MangaBindingConfidence.LOW,
        'NONE',
      ])
      .optional(),
  })
  .strict();
const bindingsQuery = z
  .object({
    ...page,
    instanceId: fromDigits(instanceId).optional(),
    anilistId: fromDigits(positiveId).optional(),
    state: z.nativeEnum(MangaBindingState).optional(),
  })
  .strict();
const confirmBody = z.object({ anilistId: positiveId }).strict();
const bindBody = z.union([
  z
    .object({ instanceId, anilistId: positiveId, suwayomiMangaId: positiveId })
    .strict(),
  z.object({ instanceId, anilistId: positiveId, sourceId, url }).strict(),
]);
const rejectBody = z
  .object({ instanceId, sourceId, url, anilistId: positiveId })
  .strict();

const sendError = (res: Response, error: MangaLibraryError) =>
  res.status(error.status).json({
    code: error.code,
    message: error.message,
    ...(error.suwayomiCode && { suwayomiCode: error.suwayomiCode }),
  } satisfies MangaLibraryErrorResponse);

const invalidRequest = () => new MangaLibraryError('MANGA_INVALID_REQUEST');

interface Decision {
  signal: AbortSignal;
  apply: () => Promise<MangaLibraryItemState>;
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
      if (error instanceof MangaLibraryError) return sendError(res, error);
      throw error;
    }
    if (!controller.signal.aborted) next();
  };

/** Applies a prepared decision under the admin's mutation admission. */
const decide = authorizedMutation(Permission.ADMIN, async (req, res) => {
  const decision = decisions.get(req);
  if (!decision) throw new Error('The review decision was not prepared.');
  if (decision.signal.aborted) return;
  try {
    res.status(200).json(await decision.apply());
  } catch (error) {
    if (error instanceof MangaLibraryError) return sendError(res, error);
    throw error;
  }
});

const mangaLibraryRoutes = Router();

mangaLibraryRoutes.get('/candidates', async (req, res) => {
  const query = candidatesQuery.safeParse(req.query);
  if (!query.success) return sendError(res, invalidRequest());
  return res.status(200).json(await listMangaCandidates(query.data));
});

mangaLibraryRoutes.get('/bindings', async (req, res) => {
  const query = bindingsQuery.safeParse(req.query);
  if (!query.success) return sendError(res, invalidRequest());
  return res.status(200).json(await listMangaBindings(query.data));
});

mangaLibraryRoutes.post(
  '/candidates/:candidateId/confirm',
  prepare(async (req, signal) => {
    const candidateId = parsePositiveRouteId(req.params.candidateId, MAX_INT32);
    const body = confirmBody.safeParse(req.body);
    if (candidateId === undefined || !body.success) throw invalidRequest();
    const { anilistId } = body.data;
    const candidate = await findMangaLibraryCandidate(candidateId);
    if (candidate.proposedAnilistId !== anilistId) {
      throw new MangaLibraryError('MANGA_PROPOSAL_CHANGED');
    }
    const { sourceId, url } = candidate;
    const read = await readMangaLibraryItem(
      candidate.instanceId,
      { sourceId, url },
      signal
    );
    return () => linkMangaLibraryItem(read, { anilistId, candidateId });
  }),
  decide
);

mangaLibraryRoutes.post(
  '/bind',
  prepare(async (req, signal) => {
    const body = bindBody.safeParse(req.body);
    if (!body.success) throw invalidRequest();
    const { instanceId, anilistId, ...lookup } = body.data;
    const read = await readMangaLibraryItem(instanceId, lookup, signal);
    return () => linkMangaLibraryItem(read, { anilistId });
  }),
  decide
);

mangaLibraryRoutes.post(
  '/reject',
  prepare(async (req) => {
    const body = rejectBody.safeParse(req.body);
    if (!body.success) throw invalidRequest();
    const { anilistId, ...key } = body.data;
    return () => rejectMangaLibraryPair(key, anilistId);
  }),
  decide
);

export default mangaLibraryRoutes;
