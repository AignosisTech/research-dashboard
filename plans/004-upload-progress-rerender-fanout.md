# 004 — Stop upload progress from re-rendering the capture subtree

- **Status**: DONE (executed 2026-08-07)
- **Commit**: 1ed0f42 + uncommitted working-tree changes (see plans/README.md "Baseline")
- **Severity**: HIGH
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 2 files, ~20 lines changed

## Problem

Axios fires `onUploadProgress` many times per second while a multi-hundred-MB
encrypted recording uploads. Two subscribers turn each of those ticks into work
far out of proportion to a progress bar.

### 1. `TestRouteGuard` subscribes to the whole test store

    // src/components/layout/TestRouteGuard.tsx:11 — current
    export const TestRouteGuard = ({ children }: TestRouteGuardProps) => {
      const { testData } = useTestStore();
      const location = useLocation();

`useTestStore()` with no selector subscribes to **every** field in the store,
including `uploadProgress`. This guard wraps `/test/instructions`,
`/test/webcam-test`, `/test/calibration`, `/test/video`, and
`/test/questionnaire` (see `src/App.tsx:86-135`), so every progress tick
re-renders the guard and its entire child subtree — including `VideoPlayback`
while it is recording, on the same main thread that is encoding video. Nothing
downstream is memoized (`React.memo` appears nowhere in `src/`), so the whole
capture screen reconciles.

The guard only reads five fields:

    // src/components/layout/TestRouteGuard.tsx:14-19 — current
    const hasRequiredData =
      testData.patient_info.name.trim() !== '' &&
      testData.patient_info.dob.trim() !== '' &&
      testData.session_id !== null &&
      testData.session_id.trim() !== '' &&
      (testData.video_count === 1 || testData.video_count === 2);

### 2. `usePendingUploads` runs an IndexedDB scan per progress tick

`src/lib/uploads/pendingUploads.ts:199` calls `setFlushState({ activeProgress })`
on every progress event, which calls `notify()`. The subscriber in
`usePendingUploads` re-reads the **whole table** each time:

    // src/hooks/usePendingUploads.ts:34-44 — current
    const refresh = async () => {
      const next = await listPendingUploads().catch(() => []);
      if (cancelled) return;
      setRows(next);
      setFlushState(getFlushState());
    };

    void refresh();
    const unsubscribe = subscribeToPendingUploads(() => {
      void refresh();
    });

So a single upload drives dozens of Dexie `toArray()` reads per second, each
producing a brand-new `rows` array that re-renders `PendingUploadsCard`. The row
_set_ only changes when an upload is added, removed, or its status changes —
never on a progress tick.

## Target

### TestRouteGuard — subscribe only to what it reads

Zustand re-renders only when the selected value changes; selecting the five
primitives means progress ticks no longer touch this component.

    // src/components/layout/TestRouteGuard.tsx — target
    export const TestRouteGuard = ({ children }: TestRouteGuardProps) => {
      // Select only the fields this guard reads — subscribing to the whole store
      // would re-render the entire capture subtree on every upload-progress tick.
      const patientName = useTestStore(s => s.testData.patient_info.name);
      const patientDob = useTestStore(s => s.testData.patient_info.dob);
      const sessionId = useTestStore(s => s.testData.session_id);
      const videoCount = useTestStore(s => s.testData.video_count);
      const campId = useTestStore(s => s.testData.camp_id);
      const location = useLocation();

      const hasRequiredData =
        patientName.trim() !== '' &&
        patientDob.trim() !== '' &&
        sessionId !== null &&
        sessionId.trim() !== '' &&
        (videoCount === 1 || videoCount === 2);

Every later reference to `testData.<field>` in this file must be updated to the
corresponding local — including the `testData.camp_id` uses in the redirect
branch. Do not introduce an object-returning selector without
`useShallow`: returning a fresh object from a selector re-renders on every store
write and would reintroduce the bug.

### usePendingUploads — separate progress from the row set

    // src/hooks/usePendingUploads.ts — target
    useEffect(() => {
      let cancelled = false;

      const refreshRows = async () => {
        const next = await listPendingUploads().catch(() => []);
        if (cancelled) return;
        setRows(next);
      };

      void refreshRows();
      void (async () => {
        if (!cancelled) setFlushState(getFlushState());
      })();

      let lastRowSignature = '';
      const unsubscribe = subscribeToPendingUploads(() => {
        const next = getFlushState();
        // Progress ticks fire many times per second; only re-read the table when
        // the queue itself changed, not when a byte counter moved.
        setFlushState(next);
        const signature = `${next.pendingCount}:${next.isFlushing}`;
        if (signature !== lastRowSignature) {
          lastRowSignature = signature;
          void refreshRows();
        }
      });

      return () => {
        cancelled = true;
        unsubscribe();
      };
    }, []);

**Before writing this, open `src/lib/uploads/pendingUploads.ts` and read the
actual `FlushState` shape.** The signature must be built from whichever fields
genuinely indicate a queue change (a count, an id list, a flushing flag) and must
**exclude** `activeProgress`. If `FlushState` carries no such field, add a
monotonically incremented `queueVersion` to it, bump it in the add/remove/status
paths only (never in the progress path), and use that as the signature — that is
the cleaner fix and is in scope for this plan.

## Repo conventions to follow

- Selector-per-field with Zustand is already the house style — imitate
  `src/pages/test/ThankYou.tsx:12` (`useTestStore(s => s.testData.camp_id)`) and
  the selector cluster in `src/pages/test/QuestionnairePage.tsx:25-28`.
- `let cancelled = false` + `if (cancelled) return` is the existing async-guard
  pattern in this hook; keep it.
- Comments explain _why_; keep the three above and add no narration.

## Steps

1. Rewrite `src/components/layout/TestRouteGuard.tsx` to use per-field selectors
   as shown, and update every `testData.` reference remaining in the file
   (including the camp redirect branch) to the new locals.
2. Read `src/lib/uploads/pendingUploads.ts` and determine which `FlushState`
   fields signal a real queue change. If none exists, add `queueVersion: number`
   to `FlushState`, increment it only where uploads are enqueued, removed, or
   change status, and leave the `onUploadProgress` path untouched.
3. Apply the `usePendingUploads` change so `setFlushState` still runs on every
   notification (the progress bar must stay live) but `listPendingUploads()` runs
   only when the signature changes.
4. Re-read the diff and remove unrelated churn. There is no test framework in
   this repo, so do not add test files.

## Boundaries

- Do NOT change upload behavior, retry logic, chunking, or encryption.
- Do NOT add `React.memo` anywhere in this plan — memoization strategy is a
  separate concern and premature here.
- Do NOT change what the progress bar displays or how often it visually updates.
- Do NOT convert the store to a different state library.
- STOP if the code has drifted from the baseline described in plans/README.md and report the drift.

## Verification

- **Mechanical**:
  - `npx react-doctor@latest --scope changed` — no new diagnostics, score not
    below 51.
  - `npm run typecheck` and `npm run lint` clean.
- **Behavior check**:
  1. **Guard still guards**: navigate directly to `/test/calibration` with no
     active session. You must still be redirected (to `/test/fillup`, or to the
     camp page when a camp session is in flight) exactly as before.
  2. **Progress bar still live**: with a pending upload, watch the dashboard's
     pending-upload card — the percentage/bytes must still tick smoothly.
  3. **Profiler (not optional)**: open React DevTools → Profiler with "Highlight
     updates" on, start a real upload from `/test/questionnaire`, and record ~10
     seconds. _Before_: `TestRouteGuard` and its subtree flash continuously and
     the commit count is in the hundreds. _After_: no flashing on the capture
     subtree; only the progress-bar component commits. Record both commit counts
     in the PR.
  4. **IDB read count**: in DevTools Performance (or a temporary
     `console.count('listPendingUploads')` inside `refreshRows`), confirm the
     table read happens on enqueue/dequeue only, not per progress tick. Remove
     the temporary counter before committing.
- **Done when**: no new diagnostics, typecheck/lint pass, redirects behave
  identically, the progress bar still animates, and the Profiler shows the
  capture subtree no longer committing during upload.
