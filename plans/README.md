# React improvement plans — research-dashboard

Produced by the `improve-react` advisor skill on 2026-08-07. React Doctor
baseline: **score 51 ("Critical"), 189 diagnostics across 115 files** (2 errors,
187 warnings) — but roughly half the diagnostics sit in unreachable code, which
is why plan 005 exists.

Every plan is self-contained: it names the exact files, quotes the current code,
and states the target. An executor needs no context from the audit conversation.

## Baseline — read this before executing any plan

The scan and **every `file:line` reference in these plans** were taken against
the **working tree** at the time of the audit: commit `1ed0f42` **plus
uncommitted changes** from the camp-features work (video-duration picker, roster
gender synonyms, camp-mode exit redirects, UPHC transfer). `git status` at audit
time showed modifications to, among others, `TestRouteGuard.tsx`,
`ExitTestDialog.tsx`, `Calibration.tsx`, `QuestionnairePage.tsx`, `Fillup.tsx`,
`CampsPage.tsx`, `CampDetailPage.tsx` and a new `CampTransferDialog.tsx`.

Consequences for an executor:

- Line numbers will **not** match a clean checkout of `1ed0f42`.
- If those camp-feature changes have since been committed, reverted, or
  reworked, treat the quoted "current" code as the source of truth and re-locate
  it by content rather than by line number.
- If the quoted code is not found at all, **stop and report the drift** instead
  of improvising — that is the standing rule in every plan's Boundaries section.

Plans 001–004 quote the exact current code they replace, so content-matching is
reliable. Plan 005 re-verifies reachability from scratch as its first step, so
it is drift-tolerant by construction.

## Status

| #   | Plan                                                                                         | Severity | Category        | Status |
| --- | -------------------------------------------------------------------------------------------- | -------- | --------------- | ------ |
| 001 | [Camera stream lifecycle races](001-camera-stream-lifecycle-races.md)                        | HIGH     | Bugs            | DONE   |
| 002 | [Face detector: cancel + throttle](002-face-detector-cancel-and-throttle.md)                 | HIGH     | Bugs / Perf     | DONE   |
| 003 | [Preserve uploads on partial failure](003-preserve-successful-uploads-on-partial-failure.md) | HIGH     | Bugs            | DONE   |
| 004 | [Upload-progress re-render fan-out](004-upload-progress-rerender-fanout.md)                  | HIGH     | Performance     | DONE   |
| 005 | [Delete dead clinic/billing subgraph](005-delete-dead-clinic-billing-subgraph.md)            | HIGH     | Maintainability | DONE   |

All five were executed on 2026-08-07 in the recommended order. Hardware-dependent
behavior checks (real camera, live backend) are still outstanding — see the
execution notes below.

### Execution notes / deviations

- **005**: 37 files deleted, all reachability re-verified first. `firebase`,
  `@hookform/resolvers`, `next-themes` removed (81 packages pruned);
  `react-hook-form` **kept** — still imported by stock `src/components/ui/form.tsx`
  (B4 territory). Stale `@firebase/util` dropped from `pnpm.onlyBuiltDependencies`.
  `pnpm-lock.yaml` refreshed; `package-lock.json` deliberately left untouched and
  still stale. Bundle: JS chunk **unchanged** (3,165.93 kB) because the dead
  cluster was never in the module graph — Firebase was never shipped. The only
  build win is CSS, 182.87 → 164.35 kB (gzip 28.16 → 25.87 kB), from Tailwind
  scanning fewer sources. Score stayed **51**; diagnostics 189 → 136 and affected
  files 115 → 78 (exactly −37).
- **002**: `sameVisibleState` also compares `movementHints` (shallow), not just
  status/message/isSuccess as drafted. Without it the `!covered` branch would
  freeze the on-screen direction arrows, since its message is a constant while
  the hints change. `metrics`/`debug` remain excluded — they render only in the
  opt-in debug panel. The plan's mechanical criterion "the `effect-needs-cleanup`
  diagnostic for this file clears" was unmeetable: the scanner never flagged
  `useFaceDetector.ts`; the only hit for that rule is the dead
  `src/components/ui/carousel.tsx:92`.
- **004**: `FlushState` had no queue-change field, so `queueVersion` was added as
  the plan's fallback allows. It is bumped in `savePendingUpload`,
  `deletePendingUpload`, `markUploadInFlight`, `clearUploadInFlight`, and after
  the failed-attempt row update in `flushPendingUploads` — never in the
  `onUploadProgress` path. That last one matters: the attempts/last_error write
  previously reached the UI only by riding the progress-tick notify storm.
  Signature is `queueVersion:isFlushing:activeId`. The initial
  `setFlushState(getFlushState())` uses the plan's async-IIFE form because
  `react-hooks/set-state-in-effect` rejects a synchronous call in the effect body.

## Recommended execution order

**005 first**, then 003, then 001 → 002, then 004.

- **005 before everything else.** It is pure deletion, it shrinks the surface the
  other plans are read against, and it retires ~40 scanner findings that would
  otherwise look like real work (including the `window-open-without-noopener` and
  `no-create-object-url-without-revoke` hits, which live only in dead billing
  code). Doing it first means every later `react-doctor --scope changed` run is
  read against a clean baseline.
- **003 next**: smallest diff, highest immediate field value, touches one file
  nothing else in this set touches.
- **001 then 002**: both are in the capture flow. 001 owns `Calibration.tsx` and
  `WebcamMicTest.tsx`; 002 owns `useFaceDetector.ts`. They do not overlap, but
  both change camera/detection lifecycle behavior, so verify 001 on real hardware
  before starting 002 — otherwise a camera regression is hard to attribute.
- **004 last** of this set: it is the one plan whose payoff must be _measured_
  (Profiler before/after), so run it against an otherwise-settled tree.

### Dependencies

- 005 → no dependencies. Do it first.
- 003, 004 → independent of each other and of 001/002.
- 002 → run **after** 001 is verified (attribution, not a code conflict).
- No two plans edit the same file.

## Vetted backlog (no plan written yet)

These were confirmed at their `file:line` but scored below the top five on
leverage ÷ effort. Listed so the judgment is not lost.

**B1 — Intake-form accessibility (HIGH, small).** Three real defects on a form
used every session: `src/index.css:314` kills the focus ring on the phone field
with `outline: none !important; box-shadow: none !important` and nothing replaces
it (WCAG 2.4.7 fail); `src/pages/test/Fillup.tsx:380` has
`htmlFor="guardian-phone-input"` pointing at an id that is never rendered, because
`src/components/auth/PhoneInput.tsx:53` accepts no `id` prop; and all validation
errors are `toast.error` only (`Fillup.tsx:112, 197, 207, 250`) with no
`aria-invalid`, no `aria-describedby`, and no focus move to the bad field. This is
arguably plan 006 — it was held back only because the other five are
data-integrity issues.

**B2 — `appendDraftChunk` read-modify-write (needs measurement first).**
`src/lib/offline/db.ts:378-406` re-reads and rewrites the whole draft record on
every `ondataavailable` tick (~every 2s, ~150 chunks per 5-minute run), inside a
Dexie transaction, while the main thread encodes video. A `draftChunks` table
keyed by `runId+seq` with `add()` only would make the append O(1). **Do not treat
the magnitude as established**: IndexedDB stores Blobs by reference, so the
rewrite copies an array of references, not video bytes — the real cost is the
transaction plus record rewrite and it may be modest. Measure with the Performance
profiler during an actual recording _before_ committing to the migration, and note
that the existing serialization queue (`draftAppendQueues`, `db.ts:376`) is
deliberate correctness machinery that any replacement must preserve.

**B3 — No route-level code splitting (MEDIUM).** `src/App.tsx:11-23` imports every
page statically and `React.lazy` appears nowhere in `src/`. A camp device opening
`/test/webcam-test` still downloads the dashboard, sessions table, assessment
sheets, `motion`, face-api and hls.js in one chunk. Splitting `/test/*` from the
dashboard bundle is the highest-value bundle work and would subsume both
`use-lazy-motion` findings by making `motion` dashboard-only. (`exceljs` is
already correctly lazy — verified at `src/lib/camps/roster.ts:168`.)

**B4 — Prune 30 unused stock `src/components/ui/*` files (LOW–MEDIUM).**
Deliberately excluded from plan 005. Worth doing as one bulk sweep because it also
drops ~12 `@radix-ui/*` packages plus `cmdk`, `embla-carousel-react`, `input-otp`,
`react-day-picker`, `react-resizable-panels`, `recharts`, and `vaul`. Individually
these deletions are churn; together they are a real dependency reduction.

**B5 — Roster table: undebounced search over ~500 unmemoized rows (MEDIUM).**
`src/components/camps/CampChildrenTable.tsx:79-102` re-filters and re-sorts the
full roster on every keystroke and re-renders up to 500 `TableRow` subtrees.
Related: `src/lib/camps/status.ts:17-53` re-derives the whole roster on every sync
emission and hands every row a new object identity, so nothing can memoize.

**B6 — `VideoPlayback.tsx` has no test seam (MEDIUM–HIGH, large).** 494 lines
inlining the MediaRecorder lifecycle, Dexie journalling, AES encryption,
pending-upload persistence, online/offline branching and run-queue navigation as
seven interlocking `useCallback`s. It is the most-edited, most-critical file in
the repo and none of its state machine is testable outside a mounted component.
`src/lib/media/screeningRecording.ts` and `src/lib/uploads/pendingUploads.ts` show
the extraction direction. Large and risky — do it deliberately, not opportunistically.

**B7 — No error boundary around the capture flow (MEDIUM).** `src/App.tsx:35` has
one root `ErrorBoundary`; a render throw under `/test/*` unmounts `VideoPlayback`,
whose cleanup drops the in-memory chunks, and the fallback offers only "Try again"
/ "Go to Dashboard" with no resume. The boundary also has no `componentDidCatch`,
so nothing is logged.

**B8 — Duplicated domain constants and types (MEDIUM).**
`SCREEN_SIZES`/`LANGUAGES` in `src/pages/test/Fillup.tsx:27-28` are byte-identical
to `CAMP_SCREEN_SIZES`/`CAMP_LANGUAGES` in `src/lib/camps/constants.ts:4-6` (that
file's own comment documents the duplication), and the same file already imports
`CAMP_STIMULUS_VERSION_OPTIONS` from there — so the fix is two import lines.
Separately, the `'male' | 'female' | 'other'` union is declared in eight places
with a title-case variant papered over by a conversion helper in
`src/components/assessments/types.ts:40-45`.

**B9 — Stored JWT is never checked for expiry (MEDIUM, security).**
`src/stores/authStore.ts:96` deliberately preserves `isAuthenticated` when
verification is inconclusive so an operator is not logged out mid-test — that
tradeoff is correct and should stay. The gap is that nothing ever checks the
token's `exp` locally, so an expired token keeps the UI authenticated
indefinitely offline, and there is no refresh path. `getUidFromToken` in
`src/lib/offline/jwt.ts:20` already decodes `exp`; wire that in as a local
expiry check without removing the offline preservation.

**B10 — No content CSP (LOW–MEDIUM, security).** `public/_headers` sets only
`frame-ancestors 'none'`; there is no `script-src`/`connect-src`/`style-src`. The
app pulls remote CSS from Google Fonts (`src/index.css:1`). Note the Razorpay
script injection that would have raised this to MEDIUM lives in
`src/hooks/useRazorpay.ts`, which plan 005 deletes — re-assess after 005 lands.

**B11 — Unbounded history growth in the capture flow (LOW–MEDIUM).**
`useExitTestDialog` (`src/components/test/ExitTestDialog.tsx:88-101`) pushes a
history entry on every mount and never pops it; `VideoPlayback.tsx:443` and
`QuestionnairePage.tsx:171` push again. Over a camp day (hundreds of children ×
2 runs) the back button becomes unusable for the operator.

**B12 — Assessment forms share ~85 lines of copy-pasted patient-details JSX
(MEDIUM).** Six forms trip `no-giant-component` (`MCHATRForm.tsx:107`,
`DSTAssessmentPanel.tsx:87`, `AIIMSForm.tsx:66`, `VanderbiltForm.tsx:60`,
`ISAAForm.tsx:54`, `CARS2Form.tsx:56`). One `<PatientDetailsCard>` extraction
retires all six findings and centralises the required-field rules. Cold path, so
low urgency — but it is the cheapest of the giant-component fixes.

**B13 — Dead exports in live files (MEDIUM).** Unlike B4/005 these sit in files
that are very much alive, so they mislead: `src/lib/offline/db.ts:190,259,339`
(`listPendingAssessmentsForSession`, `updatePendingGroundTruth`, `getDraftRun`)
imply sync capabilities that do not exist; `src/lib/api/screening.ts:36,65,105`
is a stale second API client duplicating the live research path; and
`src/lib/assessments/dst-scale.ts:58,215,271` + `aiims-scale.ts:336,356` expose
unused clinical scoring variants next to the live ones.

## Rejected — do not re-report

Confirmed at the code and deliberately dismissed:

- **Stimulus video autoplays with sound and has no captions**
  (`src/components/test/VideoPlayer.tsx:70` — `no-autoplay-without-muted`,
  `media-has-caption`). By design: this is an eye-tracking paradigm, the child
  must hear the stimulus, and captions would compete for gaze and corrupt the
  signal.
- **Camp rosters stored plaintext in IndexedDB.** Documented offline-first design;
  every table is uid-scoped and nothing leaks off-device.
- **`effect-needs-cleanup` in `src/components/ui/carousel.tsx`** (one of only two
  scanner _errors_) — stock shadcn, zero importers. Dead code.
- **Most `js-combine-iterations` / `js-set-map-lookups` hits** — micro-optimizations
  over single-digit-element arrays (roster headers, outcome codes, one session's
  runs) on cold paths.
- **`async-await-in-loop` in the sync engine** (`src/lib/offline/syncManager.ts:310`,
  `src/lib/uploads/pendingUploads.ts:188`) — deliberately sequential; the loop
  bodies re-check connectivity between iterations and upload one large video at a
  time on purpose.
- **`async-await-in-loop` in the Dexie v2 migration** (`src/lib/offline/db.ts:76`)
  — runs once per device and must stay inside the transaction.
- **`unused-dependency: workbox-window`** — false positive; consumed via
  `virtual:pwa-register` in `src/main.tsx:6`.
- **`only-export-components` on shadcn `cva` variant exports** — intended library
  pattern, HMR-only cost.

## Re-running

    npx react-doctor@latest --json --json-out react-doctor-report.json   # evidence
    npx react-doctor@latest --scope changed                             # per-plan check

Write the report outside `plans/` and delete it when done.
