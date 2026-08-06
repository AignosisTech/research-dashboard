# 002 — Stop the face-detection loop on unmount and throttle it

- **Status**: DONE (executed 2026-08-07)
- **Commit**: 1ed0f42 + uncommitted working-tree changes (see plans/README.md "Baseline")
- **Severity**: HIGH
- **Category**: Bugs & correctness (with a Performance win)
- **Rule**: react-doctor/effect-needs-cleanup
- **Estimated scope**: 1 file, ~30 lines changed

## Problem

`src/pages/test/useFaceDetector.ts` runs face detection in an **async**
`requestAnimationFrame` loop. The cleanup only cancels a pending frame — it has
no cancellation flag — so a detection that is mid-`await` when the component
unmounts will re-arm the loop _after_ teardown:

    // src/pages/test/useFaceDetector.ts:201 — current (abridged)
    async function tick() {
      if (!videoRef.current || video.paused || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      // ...
      try {
        const frameStart = performance.now();
        const results = await faceapi.detectAllFaces(video, options).withFaceLandmarks(true);
        // ... every branch calls setState({...}) with a fresh object literal
      } catch {
        // skip bad frames
      }

      rafRef.current = requestAnimationFrame(tick);   // :363 — re-arms unconditionally
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);          // :369 — only cancels a *pending* frame
        rafRef.current = null;
      }
    };

Two consequences:

1. **Orphaned loops.** `cancelAnimationFrame` cannot cancel a continuation that
   is already awaiting `detectAllFaces`. That continuation reaches `:363` and
   schedules a new frame that nothing will ever cancel — an immortal
   detection + `setState` loop. The operator enters `WebcamMicTest` once per
   child, twice per child when both stimulus versions are captured, all day; each
   unmount during an in-flight detection can strand another loop on top of the
   MediaRecorder that later runs on the same thread.

2. **No sampling interval.** `tick` re-schedules immediately after each
   detection, so it runs as fast as the device allows, and every branch
   (`:221`, `:249`, `:292`, `:309`, `:327`) calls `setState` with a **new object
   literal** — re-rendering `WebcamMicTest` and the `WebcamPreview` overlay on
   every detected frame even when the status and message are identical. There is
   no `React.memo` anywhere in `src/`, so nothing downstream absorbs it.

The sibling hook `src/pages/test/hooks/useLightingCheck.ts` already samples on an
interval (`SAMPLE_INTERVAL_MS`) rather than every frame — this hook is the
outlier.

## Target

Follow recipe **(D) Async Callbacks with Mutable State** from the canonical
`react-doctor/effect-needs-cleanup` prompt — keep a mutable flag and clear
everything from the one returned teardown:

    // canonical shape
    useEffect(() => {
      let timer = null;
      observer.on("event", () => {
        timer = setTimeout(() => doWork(), 100);
      });
      return () => {
        if (timer) clearTimeout(timer);
        observer.stop();
      };
    }, []);

Applied here — a `cancelled` flag checked at both the top of `tick` and after
every `await`, plus a sampling interval and a no-op guard on `setState`:

    // src/pages/test/useFaceDetector.ts — target
    const DETECT_INTERVAL_MS = 200;   // ~5 Hz, matching useLightingCheck's cadence

    // inside the effect, before `async function tick()`
    let cancelled = false;
    let lastDetectAt = 0;

    async function tick() {
      if (cancelled) return;

      if (!videoRef.current || video.paused || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const W = video.videoWidth || 0;
      const H = video.videoHeight || 0;
      if (W < 1 || H < 1) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Sample at a fixed cadence instead of every frame: detection is the most
      // expensive main-thread work on the page and the UI only shows a status.
      const now = performance.now();
      if (now - lastDetectAt < DETECT_INTERVAL_MS) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastDetectAt = now;

      try {
        const frameStart = performance.now();
        const results = await faceapi.detectAllFaces(video, options).withFaceLandmarks(true);
        if (cancelled) return;                    // unmounted mid-detection: do not re-arm
        const frameEvalMs = performance.now() - frameStart;
        // ... existing branch logic unchanged ...
      } catch {
        // skip bad frames
      }

      if (cancelled) return;
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

And stop re-rendering when nothing the UI shows has changed. Add this helper at
module scope and route the `no_face` / success / failure branches through it
instead of calling `setState` with a bare object literal:

    // src/pages/test/useFaceDetector.ts — module scope, target
    /** Skip the state write when nothing the UI renders actually changed. */
    const sameVisibleState = (a: FaceDetectorState, b: FaceDetectorState) =>
      a.status === b.status && a.message === b.message && a.isSuccess === b.isSuccess;

    // at each setState call site, e.g. the :221 no_face branch:
    setState(prev => {
      const next = {
        status: 'no_face' as const,
        message: tCur.noFace,
        metrics: null,
        movementHints: [],
        debug: { totalFaces: 0, validFaces: 0, bestDetectionScore: null, frameEvalMs },
        isSuccess: false,
        modelsLoaded: true,
        error: null,
      };
      return sameVisibleState(prev, next) ? prev : next;
    });

Returning `prev` unchanged makes React bail out of the re-render entirely.
`debug.frameEvalMs` changes every sample and is deliberately excluded from the
comparison — it is diagnostic only. If any UI reads `debug` live, keep that
branch writing unconditionally and say so in the PR.

## Repo conventions to follow

- Module-scope constants are `SCREAMING_SNAKE_CASE` with a short comment —
  imitate `SAMPLE_INTERVAL_MS` in `src/pages/test/hooks/useLightingCheck.ts`.
- The functional-update form `setState(prev => ...)` is already used in this file
  (e.g. `:344-356`) — match it.
- Comments explain _why_; keep the three explanatory comments above and add no
  narration.

## Steps

1. Add `DETECT_INTERVAL_MS` and the `sameVisibleState` helper at module scope in
   `src/pages/test/useFaceDetector.ts`.
2. Inside the effect (the one whose deps are `[enabled, state.modelsLoaded, videoRef, language]`
   at `:373`), declare `let cancelled = false;` and `let lastDetectAt = 0;` before
   `async function tick()`.
3. Add the four guards from Target: `if (cancelled) return;` at the top of
   `tick`; the `DETECT_INTERVAL_MS` throttle before the detection call; the
   `if (cancelled) return;` immediately after the `await` on `:216`; and the
   `if (cancelled) return;` before the trailing `requestAnimationFrame` on `:363`.
4. Set `cancelled = true;` as the first statement of the cleanup at `:367`.
5. Convert each `setState({...})` branch (`:221`, `:249`, `:292`, `:309`, `:327`
   — verify the exact set at the current commit) to the `setState(prev => ...)`
   bail-out form. Do not change any status/message/metric values.
6. Re-read the diff and remove unrelated churn. There is no test framework in
   this repo, so do not add test files.

## Boundaries

- Do NOT change the detection thresholds, `MIN_SCORE`, `inputSize`, the
  `isFrontFace` logic, or any user-facing message.
- Do NOT change the hook's public return shape (`{ ...state, retryLoadModels }`).
- Do NOT add dependencies or a web worker — moving detection off-thread is a
  separate, larger change.
- Do NOT touch `Calibration.tsx` or `WebcamMicTest.tsx` — that is plan 001.
- STOP if the code has drifted from the baseline described in plans/README.md and report the drift.

## Verification

- **Mechanical**:
  - `npx react-doctor@latest --scope changed` — the `effect-needs-cleanup`
    diagnostic for this file clears and the score does not regress below 51.
  - `npm run typecheck` and `npm run lint` clean.
- **Behavior check** (needs a real camera):
  1. On `/test/webcam-test`, confirm the face-status messages still transition
     correctly: cover the camera → "no face" copy; sit in frame → success state;
     move off-centre → the same movement hints as before. Detection must still
     feel responsive at ~5 Hz.
  2. **Orphan-loop check**: add a temporary `console.count('tick')` at the top of
     `tick`, enter `/test/webcam-test`, navigate away via the exit dialog, and
     confirm the count **stops** within one frame. Before the fix it keeps
     climbing. Remove the temporary log before committing.
  3. **Profiler**: record in React DevTools with "Highlight updates" enabled while
     sitting still in frame. Before: `WebcamMicTest`/`WebcamPreview` flash on
     every detected frame. After: no flashing while the status is steady, and the
     commit count over 10 seconds drops sharply. Record both numbers in the PR.
- **Done when**: the diagnostic is clear, score not lower, typecheck/lint pass,
  the tick count stops on unmount, and the Profiler shows no commits while the
  face status is unchanged.
