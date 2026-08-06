# 003 — Preserve successful uploads when one capture run fails

- **Status**: DONE (executed 2026-08-07)
- **Commit**: 1ed0f42 + uncommitted working-tree changes (see plans/README.md "Baseline")
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 1 file, ~35 lines changed

## Problem

`src/pages/test/QuestionnairePage.tsx:76` gathers every capture run's upload with
`Promise.all`. One rejected run rejects the whole batch, so control jumps to the
`catch` at `:147`, which throws away the _successful_ runs' results and routes to
the error page:

    // src/pages/test/QuestionnairePage.tsx:76 — current
    setSubmissionPhase('upload');
    const uploadResponses = await Promise.all(uploadPromises);
    // Runs saved locally (offline) resolve without a tid.
    const serverResponses = uploadResponses.filter(
      (r): r is ResearchTestUploadResponse => !('offline' in r)
    );

    // src/pages/test/QuestionnairePage.tsx:141 — current
        if (testData.camp_child_id) {
          await markCampChildRecorded(testData.camp_child_id);
        }

        clearUploadPromises();
        navigate('/test/thankyou', { replace: true });
      } catch (err) {
        console.error('Submission error:', err);
        toast.error('Failed to submit. Please try again.');
        clearUploadPromises();
        navigate('/test/error', { replace: true });
      } finally {
        isProcessingRef.current = false;
      }

Three concrete failures follow from this on a two-video session:

1. **The roster row stays "Pending" even though the data is safe.** For a camp
   child, `markCampChildRecorded` (`:142`) never runs, so
   `src/lib/camps/status.ts` keeps deriving `pending`. Meanwhile the encrypted
   payloads for both runs are already durable in Dexie's pending-upload queue and
   _will_ sync on their own. The operator sees an unrecorded child and re-records
   them — a second, redundant session for a child who is already done.

2. **A questionnaire that could have been saved is dropped.** The `catch` is
   reached before the questionnaire branch at `:109`, even though the flow
   already knows how to persist answers locally (`queueQuestionnaireLocally`,
   `:96`) and the code comment at `:119` calls those answers "irreplaceable".

3. **`markCampChildRecorded` failing takes down a fully successful submission.**
   It is awaited inside the same `try`, so a Dexie hiccup after every upload
   landed still dumps the operator on `/test/error`.

`Promise.allSettled` is the right primitive: the partial success is real and
already durable, and the flow's own offline path (`anyLocal`, `:81`) is designed
for exactly this "some runs are not on the server yet" state.

## Target

Replace the all-or-nothing gather with `allSettled`, treat a rejected run the
same way the flow already treats an offline run, and move the roster mark outside
the failure path:

    // src/pages/test/QuestionnairePage.tsx — target
    setSubmissionPhase('upload');
    const settled = await Promise.allSettled(uploadPromises);

    const fulfilled = settled
      .filter((s): s is PromiseFulfilledResult<RunUploadResult> => s.status === 'fulfilled')
      .map(s => s.value);
    const rejectedCount = settled.length - fulfilled.length;

    if (rejectedCount > 0) {
      // The run's encrypted payload is already queued in Dexie, so a failed
      // in-flight upload is the same situation as an offline run: the sync
      // engine owns it from here. Do not discard the runs that did land.
      settled
        .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
        .forEach(s => console.error('Run upload failed, deferred to sync queue:', s.reason));
    }

    // Runs saved locally (offline) resolve without a tid.
    const serverResponses = fulfilled.filter(
      (r): r is ResearchTestUploadResponse => !('offline' in r)
    );
    const anyLocal = rejectedCount > 0 || serverResponses.length < fulfilled.length;
    const lastTid = serverResponses[serverResponses.length - 1]?.tid;
    if (lastTid) {
      setTestData({ test_id: lastTid });
    }

`anyLocal` now also covers the rejected runs, which makes the existing logic do
the right thing with no further change: the questionnaire is queued locally at
`:114` rather than POSTed (the server 409s until every run is uploaded), the
"Saved on this device" toast fires at `:133`, and `processSyncQueue()` is kicked
at `:134`.

Then make the roster mark non-fatal and keep it on the success path:

    // src/pages/test/QuestionnairePage.tsx:141 — target
        if (testData.camp_child_id) {
          // A roster-marking failure must not discard a submission whose data
          // is already durable — the child really was recorded.
          try {
            await markCampChildRecorded(testData.camp_child_id);
          } catch (markErr) {
            console.error('Failed to mark camp child recorded:', markErr);
          }
        }

        clearUploadPromises();
        navigate('/test/thankyou', { replace: true });

`RunUploadResult` is already the element type of `uploadPromises` in
`src/stores/testStore.ts` — import the type if it is not already in scope in this
file rather than widening to `unknown`.

## Repo conventions to follow

- Type predicates in filters (`(r): r is ResearchTestUploadResponse => ...`) are
  the established style here — `:78-80` — keep it for the `allSettled` filters.
- Errors are surfaced with `console.error(...)` plus a `toast` only when the user
  must act; a deferred-to-sync run is not user-actionable at this moment, so log
  it and let the existing "Saved on this device" toast cover the user-facing
  message.
- Comments explain _why_. Keep the two above; add no narration.

## Steps

1. In `src/pages/test/QuestionnairePage.tsx`, replace the `Promise.all` block at
   `:76-85` with the Target `allSettled` version.
2. Confirm `RunUploadResult` is imported (it is defined alongside
   `uploadPromises` in `src/stores/testStore.ts`); add the type import if
   missing, in the existing import group.
3. Wrap the `markCampChildRecorded` call at `:141-143` in the `try/catch` shown
   in Target.
4. Leave the outer `catch` (`:147-151`) as-is — it now only catches genuine
   submission failures (e.g. a non-network questionnaire rejection rethrown at
   `:124`), which is the correct behavior.
5. Re-read the diff and remove unrelated churn. There is no test framework in
   this repo, so do not add test files.

## Boundaries

- Do NOT change the offline queueing helpers, the sync engine, or
  `pendingUploads`.
- Do NOT change what is uploaded, encrypted, or the questionnaire payload shape.
- Do NOT remove the `/test/error` route or the outer `catch`.
- Do NOT "fix" the unhandled-rejection warning by attaching `.catch` at
  `addUploadPromise` in `VideoPlayback.tsx` — that is a separate backlog item.
- STOP if the code has drifted from the baseline described in plans/README.md and report the drift.

## Verification

- **Mechanical**:
  - `npx react-doctor@latest --scope changed` — no new diagnostics, score not
    below 51.
  - `npm run typecheck` and `npm run lint` clean.
- **Behavior check**:
  1. **Happy path unchanged**: run a full two-video camp session online. It must
     still land on `/test/thankyou`, and the camp roster row must flip to
     recorded/synced exactly as before.
  2. **Partial failure** (the fix): start a two-video session; after run 1
     uploads, use DevTools Network → "Offline" (or block
     `**/research/test/data`) so run 2's upload rejects. Complete the
     questionnaire. Expected after the fix: you land on `/test/thankyou`, the
     "Saved on this device — everything will upload automatically when online"
     toast appears, the camp roster row shows **recorded** (not pending), and the
     pending-upload card on the dashboard lists the outstanding run. Restore the
     network and confirm it syncs and the row reaches synced. Before the fix the
     same steps land on `/test/error` with the row still pending.
  3. **Roster-mark failure is non-fatal**: temporarily make
     `markCampChildRecorded` throw; confirm the flow still reaches
     `/test/thankyou` and only logs. Revert the temporary throw.
- **Done when**: no new diagnostics, typecheck/lint pass, and the partial-failure
  run ends on the thank-you screen with the roster row marked recorded and the
  outstanding run visible in the pending-upload queue.
