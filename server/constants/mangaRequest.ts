/** Which chapters a manga request asks for. */
export enum MangaRequestScope {
  /** Every chapter the source lists when the request is dispatched. */
  ALL_AT_DISPATCH = 'ALL_AT_DISPATCH',
  /** The chapters with the N highest chapter numbers. */
  LATEST_N = 'LATEST_N',
  /** The chapters numbered from `rangeStart` to `rangeEnd`, inclusive. */
  RANGE = 'RANGE',
}

/**
 * Whether the request's title has an ACTIVE source binding on its target
 * instance. A hint kept in step with the bindings; dispatch re-verifies it.
 */
export enum MangaRequestBindingState {
  /** Parked: no ACTIVE binding exists yet on the target instance. */
  AWAITING_BINDING = 'AWAITING_BINDING',
  BOUND = 'BOUND',
}

/** Dispatch steps, in order. Each names the last step completed. */
export enum MangaRequestCheckpoint {
  BINDING_VERIFIED = 'BINDING_VERIFIED',
  INSTANCE_MARKED = 'INSTANCE_MARKED',
  LIBRARY_ADDED = 'LIBRARY_ADDED',
  CATEGORY_READY = 'CATEGORY_READY',
  CHAPTERS_FETCHED = 'CHAPTERS_FETCHED',
  MANIFEST_FROZEN = 'MANIFEST_FROZEN',
  CHAPTERS_ENQUEUED = 'CHAPTERS_ENQUEUED',
}
