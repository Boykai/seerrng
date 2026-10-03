# Interface Integration Checkpoint

This is the living evidence appendix for the forward-merge guide, not a release
approval or a complete site-audit claim. Read `AGENTS.md`, UI Style Standard and
UI Fix-It first. Preserve earlier accepted work while reviewing small batches.
Never infer human acceptance from test success or a journal's implementation note.

## Preservation and coverage map

| Work to preserve                                                       | Established owners and existing checks                                                                                                                                                                            | Review boundary                                                                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request Status and request-modal layout, filters, actions, title roles | `globals.css`, Request components; `src/styles/buttonGeometry.test.mjs`, `requestLayout.test.mjs`, current-batch contract                                                                                         | Earlier work is in scope for the contribution; a Series-first batch does not remove it. Final accepted references and current narrow renders remain to be assembled. |
| Shared page titles/headings, typography and spacing                    | `page-title`, `page-heading`, card/table families; `buttonGeometry.test.mjs`, current-batch contract                                                                                                              | Preserve role owners and existing acceptance, not retired experimental values.                                                                                       |
| Aggregate loading/searching/mutation status                            | `page-title-row`, `page-status`, shared status/spinner; `buttonGeometry.test.mjs` and component tests                                                                                                             | Keep one real activity indicator; completion/unmount must clear contributions.                                                                                       |
| Poster dimensions, buttons, media slots and hover                      | `poster-layout`, poster frame/region/control roles; `buttonGeometry.test.mjs`, `iconOnlyButtons.test.mjs`                                                                                                         | Fixed browsing geometry is distinct from detail/credit posters. Trace all affected renderers.                                                                        |
| Series tree, quality, native controls and disclosure ordering          | Series components, shared selection/tree/ratings/disclosure owners; `seriesDetailsStyle.test.mjs`, native-action suites and reorder suites                                                                        | Selection and permissions remain functional contracts. Mocked drag tests do not prove physical drag/touch acceptance.                                                |
| Current Plex Collection repair                                         | `server/api/plexapi.ts`, native collection routes/client; `server/api/plexCollections.test.ts`, `src/styles/mediaServerCollectionsClient.test.mjs`, `mediaServerCollections.test.mjs`, `plexCollections.test.mjs` | Optional smart marker is accepted only with remaining exact identity checks. Remove only membership, never the collection.                                           |
| Mutable Watchlist/Collection state                                     | `server/middleware/apiResponseCache.ts`, native clients, `ServiceWorkerSetup/sw.ts`; cache/client/service-worker tests                                                                                            | Fresh initial/pre-write reads and confirmed desired state; local Seerr watchlist and Plex Watchlist remain distinct.                                                 |
| Dropdown opacity, overflow and ancestor framing                        | Shared dropdown/menu surface and detail-card open state; `seriesDetailsStyle.test.mjs`, `Common/Dropdown/playbackStyle.test.tsx`                                                                                  | Parsed source ownership is not rendered paint-order proof. Compare open and closed desktop/narrow states.                                                            |

The broader [Interface Preservation Inventory](interface-preservation-inventory.md)
has been reconciled against the journal and original chat. It covers the Request
page and shared roles, poster/browse prototypes, dropdown/mosaic cleanup, final
tree/table/workspace, ratings, ordering and native actions. It distinguishes
explicit acceptance, pending review, retired trials and opt-in references.
Neither document replaces the final three-way changed-file inventory. Rolled-back
successor changes must not be resurrected because an older log mentions them.

## Confirmed provider evidence before this batch

- Plex Collections: authorized Seerr Add, Remove and Add again with matching
  provider and Seerr membership readback. The test collection was retained for
  John's manual trial, not deleted. This was a bounded own-account verification.
- Plex Watchlist: the stale mismatch was reproduced; authorized removal of the
  reported series reduced membership by one and a fresh Plex reload confirmed
  absence. Adding it back restored membership and the Remove action. The item
  remains saved. This is live evidence, separate from mocks.
- Jellyfin/Emby native actions: mocked tests only; no live write pass claimed.
- Previous focused passes do not establish a full cumulative suite/build pass.
  Human visual acceptance and physical drag/touch review remain pending.

## Current bounded batch

Approved: improve portable instructions, regression checks and merge evidence;
repair only clear existing visual-rule violations in the Series/shared controls.
Not approved: broad backend/security repair, new design presets, NAS deployment,
GitHub push/PR or production-account tests as part of a visual audit.

The original public `dev`, `build`, validation and hook bindings remain intact.
Focused checks support iterative previews; finalization requires one complete
gate on the exact candidate. `pnpm build` runs validation then compilation, so
do not run another identical full validation immediately beforehand.

Known remaining visual debt: legacy Series/shared `@apply` and competing card
padding owners require a later bounded consumer audit. A long action-menu list
needs an approved bounded-viewport preset; do not invent dimensions here. This
batch does not establish that the page or application is Tailwind-free.

Current isolated focused batch: **117 tests passed**, zero failures, skips,
cancellations or todos. Suites: local-validation bindings/discovery/isolation,
buttonGeometry, iconOnlyButtons, requestLayout, Series style and saved-item
client. New negative fixtures reject competing clipping/surface/gap owners and
retired icon geometry; Watchlist Remove tests confirm explicit desired false
and fresh already-completed state. Two old icon assertions were superseded by
the documented shared-padding/native poster-role contract, not waived.

Isolation: separate candidate source, disposable `/tmp` config, Docker network
mode `none`, dependencies/store mounted read-only; no live config/DB mount.
Formatting and discovery plan passed. All 12 explicit files matched the mounted
source readback. Desktop/narrow menu inspection confirmed the shared black surface,
open content above its parent frame, keyboard access to the last option, and Escape
restoring normal clipping/layers/focus. Narrow tree headings still crowd; physical
drag/touch and final human visual acceptance remain pending.

The one full `pnpm build` attempt passed translations, current-batch and shared-
style validators, formatting, lint, server/client types and all 85 Vitest files
(395 tests). **Blocked:** during the native TypeScript lane, the network guard
failed after AvailabilitySync because of an unstubbed TMDB attempt. The related
test, implementation and guard match the pre-batch source. This is an unchanged
test-isolation failure, not proof of a production backend defect.

The isolated run was stopped after that required failure. Native TS is incomplete;
the cumulative native JS/tooling lanes and production compilation were not run.
No complete gate/build pass, exception or waived failure is claimed. No unrelated
backend/test repair was made in that attempt. Preserve the failed receipt
separately from focused passing evidence.

John subsequently authorized repairing that suite's test isolation with production
backend code untouched. The focused failure was reproduced with the guard enabled;
the test now mocks the actual retained TMDB client with typed season fixtures and
per-test restoration. Unexpected fixture IDs fail outside the production catch.
A new unavailable-enrichment case checks the exact lookup and preserved status.
All 18 focused tests pass, with no skips/cancellations/todos. This test-only repair
is not a production backend fix or a complete cumulative gate/build pass. The
final gate and human acceptance remain pending; unrelated failures still require
scoped direction before further repair.

The visual/client fixtures were also tightened: negative CSS/role fixtures must
fail with their intended diagnostics, wrong icon padding is checked without a
duplicate declaration, and Watchlist Remove rejects a valid response that still
reports saved membership. Recovery remains read-only. The six focused visual/
client/runner suites now pass **119 tests**, zero failures/skips/cancellations/
todos; the separate AvailabilitySync focused suite passes 18. Production backend,
network guard, package/hook bindings and lockfile remain unchanged. The complete
candidate is being verified separately; these focused receipts are not a waiver
or full-gate claim. Internal-only test hardening adds no user-facing feature.

## Subsequent isolated verification and input blockers

The repaired cumulative retry passed the preliminary validators, formatting,
lint, server/client types and all85 Vitest files/395 tests. AvailabilitySync
passed within the native TS lane. A different required after-hook then failed
following the Plex scanner suites: the guard caught an attempted request to a
fake Plex test host. That scanner source and guard are unchanged from the
preserved baseline. This is isolation evidence, not a production bug diagnosis.
The long run was stopped there; exit137 records the stop, separately from the
hook failure. Native TS remains partial; no production compilation was reached.
No scanner/guard repair or failure waiver was made.

The previously unrun native JavaScript lane was executed separately on the same
frozen candidate: all46 selected files ran,391 tests,357 passed,34 failed, zero
skips/todos/cancellations. This is a failing partial receipt, not a complete gate.
Failures include superseded source/utility assertions and unresolved contracts;
replace only clearly superseded assertions with equivalent role/behavior tests
and negative fixtures. Do not restore retired layouts or normalize uncertain
palette/ordering decisions merely to increase the pass count.

Full tooling inputs are also unavailable: the mounted app source contains only
the CI workflow, while tests read other chart/release/preview workflows and root
release fixtures. The bare Node/Alpine image lacks required native tools.
The earlier snapshot additionally omitted an existing Unraid template fixture;
that omission is corrected in future manifests, not inserted into the frozen
receipt. Establish complete authoritative pinned Git inputs and a suitable
disposable toolchain before another final run. Plan discovery is not proof of
fixture/tool availability. No borrowed fixtures, installed live tools or suite
exclusions convert these blockers into a pass.

## Bounded visual-contract follow-up

One established implementation violation was repaired: the single-option
Request icon's local16px utility is removed only after its real branch is
attached to the existing shared14px content-size owner. No new geometry or
palette was designed, and production backend code is unchanged.

Seven visual test files now follow the current Requests consumer, accepted
semantic table/gap owners and Series saved-order/controlled-disclosure behavior.
Superseded source/utility assertions were replaced with property/role/callback
coverage and diagnostic-specific negative fixtures. The affected nine-suite
execution (including shared button/icon checks) ran157 tests:153 passed, four
failed, no skips/todos/cancellations. Three failures were in the new icon checker:
it initially audited unrelated root palette aliases and mishandled PostCSS's
separate important flag. After correcting that checker, only its changed six
tests were rerun: all six pass. The other required Book ordering failure is
unchanged and unresolved; no full affected or cumulative pass is claimed.

Current-batch/shared-style validators and changed-component lint pass;
formatting passes. The actual PostCSS configuration compiles the shared CSS
with zero warnings. Palette/theme, Book-order and other unreconciled failures
remain recorded. The earlier frozen full/native-JS receipts are retained;
this follow-up has only focused evidence and still needs rendered/human review.
Repository/toolchain prerequisites and full gate/build remain blocked.

## Latest bounded preview checkpoint — October 2, 2026

This section supersedes earlier current-status descriptions above, not their
preserved diagnostic receipts. John limits further preview verification to the
Requests page, Series page, Discover's Recent Requests slider, and shared poster
styles across their consumers. A poster-role check does not authorize a whole-page
audit of each consumer. No broad backend repair or site-wide page sweep is approved.

The two inherited network-isolation failures also reproduce on untouched upstream
v3.44.1 and the subsequently tested main. They do not establish that the visual
changes introduced a production defect. Original tests and failed receipts are
backed up. John's exact-file/target temporary diagnostic deferrals are opt-in;
outbound requests remain blocked and strict default behavior remains intact.
Deferred required failures are not a passing release gate. Reconcile the original
tests and the maintainer's coverage before final contribution acceptance.

The retired CSS-representation assertions have been reconciled with the current
shared classes, variables and accepted semantic roles, retaining meaningful
behavioral safeguards and negative coverage. That source lane passed 410 tests
in 47 files, with no failures or skips. The previously completed component lane
passed 395 tests. These are separate receipts from an earlier exact source state,
not a complete cumulative pass for the final tree. The three broad native
receipt-recovery partitions were intentionally stopped when John narrowed scope;
their partial reports must not be counted as passing or restarted automatically.
Unrelated tooling findings remain documented rather than repaired or waived.

A subsequent narrow cleanup removes competing card-padding ownership: main media
cards retain the existing shared main-padding owner rather than also consuming
inset padding. The overwritten local padding utility and duplicate blur declarations
were removed. The shared poster layout retains positioning while the shell retains
only its independent stacking role. Current main/inset padding remains 8px;
browsing posters remain 169.2px wide with a 2:3 frame. No component, production
backend, dependency, live configuration or provider data changed in this cleanup.

Current focused receipts, executed once per final affected selection:

1. Seven card/poster owner and menu checks passed, including negative mutation
   checks (`mediaCardOwners.test.mjs` and the two selected menu contracts).
2. Thirteen native frontend poster badge/link and slider tests passed in three
   files: `TitleCard/statusBadges.test.ts`, `TitleCard/bookDetailQuery.test.ts`,
   and `utils/mediaSlider.test.ts`.
3. Nine native frontend Requests user-filter and Series availability-tone tests
   passed in `Requests/requestStatusQuery.test.ts` and
   `MediaDetails/AvailabilityValue.test.ts`.

Those 29 tests have zero failures, skips, cancellations or todos. Native runs used
isolated source/config, read-only dependencies, no network, strict network guards,
and no temporary network-deferral flag. Formatting passed. Published CSS/test
readback matched the tested files; the complete source comparison found no
unexpected component/backend changes or deletions.

Rendered review confirms Requests at 1440px and 390px, Series at the existing
desktop-sized viewport and 390px, and the request slider at 390px. Requests uses
36px/40px page-title typography above the breakpoint and 24px/28px below it;
cards retain 8px padding. Neither reviewed narrow page has page-wide horizontal
overflow. Poster positioning and frame dimensions remain intact. The desktop
collection-menu capture shows an opaque black surface extending beyond the main
card without clipping; Escape closes it. Request-slider Next moved the track by
one compact-card width, and Previous restored its disabled-at-start state.
The landscape request-summary cards are not portrait browsing posters.

Legacy compact request-card utilities and remaining shared `@apply` are explicitly
not a Tailwind-free claim. Loading/error/empty variants, every alternate theme,
physical drag/touch, and unaudited pages are not newly certified by these captures.
No live provider mutation was repeated during this visual cleanup. Detailed source
hashes, receipts, recovery files and screenshot locations are in the recovery
journal.

John explicitly accepted the visual test for this scoped cleanup on October 2,
2026, while on his phone, based on the previously proven CSS and absence of major
visual changes beyond utility/duplicate-owner cleanup. This is his approval of
the current bounded visual batch, not a claim that he newly inspected every
desktop/narrow screenshot or certified unreviewed themes, states or pages.
Earlier review gaps above remain recorded; this approval does not silently
certify physical drag/touch or other untested interactions.

The complete strict gate/build, GitHub checks and publication authorization
remain pending. Visual acceptance does not waive deferred required test failures
or authorize a PR. CI success must be matched to the actual shared-gate inventory,
not assumed to cover every local check.

## Finalization authority and latest accepted scope — October 3, 2026

John explicitly accepted the current preview and authorized final checks, a
contribution to `snapetech/seerrng`, monitoring relevant CI failures, deployment
of the tested preview build to his server, and bounded nightly cleanup. These
instructions supersede the earlier pending publication/deployment authority;
they do not waive a required failure or authorize unrelated backend repairs.

The accepted candidate now uses the newer upstream 3.46.1 main at
`e7305281797cd7527c3b1c0a83ff144218ad506a`. Later accepted work includes shared
blue pinnable catalog filters and titles, the yellow watchlist visibility action,
the reused Series request tree and adjacent Episode Queue, a single Series
request entry, six-role Overview disclosure/order, and native shared CSS cleanup
for active Series detail/request/browse controls. The latest focused receipts
are not the cumulative release gate. Remaining utility-dependent conditional
overlays, settings-specific controls, physical drag/touch, and unaudited pages
are not newly certified or claimed Tailwind-free.

Final independent review identified an API-contract mismatch: Overview expanded
the Series role set to six while the OpenAPI order schema still described five.
The schema must match the same six-role server owner before final validation,
including persisted user settings, request payloads and normalized responses.

Publication must also follow the current contribution guide's requirement that
John supplies his own-word PR description and accurate AI disclosure. Automated
code/testing evidence does not supply that human-authored publication input.
If that input is absent, preserve the contribution on a verified remote branch
and report publication as pending rather than misrepresent authorship.

## Required evidence at contributor finalization and maintainer integration

Fill these fields with observed facts; unknown means pending, never assumed.

1. Contributor remote/branch/commit; pinned maintainer target remote/branch/commit;
   actual common ancestor; integrated commit; exact tested commit/source digest.
   All commit IDs are pending until the actual authorized Git integration.
2. Pinned Node/pnpm identities, lockfile SHA-256, environment/platform, isolated
   source/config/dependency mounts and actual network boundary.
3. Three-way changed-file inventory and conflict ledger: owner, newer upstream
   behavior/security requirements, preserved interface rule, resolution and check.
   Do not wholesale restore an older backend, component or lockfile.
4. Discovery plan versus executed logs: test file inventory, test totals, failures,
   skips/todos, platform exclusions, lint/type/static/style results and build result.
   `pnpm test` is test partitions only; `test:ci` is Vitest-only. Browser/Cypress
   suites are separate. Linux is required for complete POSIX tooling coverage.
5. Desktop/narrow reference locations and John's acceptance per page/state,
   including loading/error/empty, keyboard/focus/disabled, open menus and reorder.
   An automated screenshot or computed-style result is not human acceptance.
6. Live Plex evidence separately from mocked native coverage; safe prerequisites
   for unverified providers. Never copy credentials, runtime DBs or live config.
7. Explicit deferrals, unresolved failures and next gate. A failed required gate
   blocks finalization; report unrelated backend failures before expanding scope.
8. Recoverable refs/archive identity and checksums, final source readback, and
   applicable publication authority. Local preview publication is not PR approval.

The contributor and Keith's AI must use the same checked-in instructions and
gate, adapted to the newer target without discarding its valid security/backend
fixes. If the target advances, pin the new head and repeat invalidated checks.
