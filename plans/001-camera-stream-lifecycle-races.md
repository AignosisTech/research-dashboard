# 001 — Fix camera stream lifecycle races in the capture flow

- **Status**: DONE (executed 2026-08-07)
- **Commit**: 1ed0f42 + uncommitted working-tree changes (see plans/README.md "Baseline")
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 2 files, ~40 lines changed

## Problem

Two separate races leave `MediaStream`s alive or double-acquired. On the low-end
tablets used at camps a camera that is still held by a previous stream makes the
next `getUserMedia({ deviceId: { exact } })` reject with `NotReadableError` /
`TrackStartError`. The operator sees a black preview and "Error switching camera
device", and the child has to be re-seated. This happens per child, all day.

### Race 1 — `Calibration` never stops a stream that arrives after unmount

`src/pages/test/Calibration.tsx:141` starts the webcam asynchronously, but the
cleanup at `:165` decides what to stop by reading `videoEl.srcObject`, which is
still `null` while `getUserMedia` is in flight. Unmounting during that window
(the operator hits Back, or the exit dialog fires) leaves the camera running
forever:

    // src/pages/test/Calibration.tsx:141 — current
    const startWebcam = async () => {
      if (!navigator.mediaDevices.getUserMedia) {
        console.error('getUserMedia not supported');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: testData.device_id ? { exact: testData.device_id } : undefined,
            ...SCREENING_VIDEO_CONSTRAINTS,
          },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.addEventListener('canplay', handleCanPlay);
        }
      } catch (error) {
        console.error('Webcam start error:', error);
      }
    };

    startWebcam();

    return () => {
      if (videoEl) {
        videoEl.removeEventListener('canplay', handleCanPlay);
        if (videoEl.srcObject) {
          const stream = videoEl.srcObject as MediaStream;
          if (stream && typeof stream.getTracks === 'function') {
            stream.getTracks().forEach(track => track.stop());
          }
          videoEl.srcObject = null;
        }
      }
    };

### Race 2 — `WebcamMicTest` holds two streams for one camera

`switchCamera` at `src/pages/test/WebcamMicTest.tsx:211` acquires the new stream
at `:215` **before** releasing the old one at `:216`, so both exist at once for
the same physical device:

    // src/pages/test/WebcamMicTest.tsx:211 — current
    const switchCamera = useCallback(
      async (deviceId: string) => {
        if (!deviceId) return;
        try {
          const newStream = await acquireStream(deviceId);
          stopCurrentStream();
          stopAnalysis();
          streamRef.current = newStream;
          attachStreamToVideo(newStream);
          startAnalysis(newStream);
          updateTestStoreWithCamera(deviceId, getCameraLabel(deviceId, devices));
        } catch (err) {
          console.error('Error switching camera:', err);
          setError('Error switching camera device');
        }
      },
      [
        acquireStream,
        stopCurrentStream,
        stopAnalysis,
        attachStreamToVideo,
        startAnalysis,
        updateTestStoreWithCamera,
        devices,
      ]
    );

It is also called redundantly. `checkExistingPermissions` (`:145`) and
`requestPermissions` (`:179`) each already acquire a stream _and_ call
`setSelectedDevice`, which fires this effect:

    // src/pages/test/WebcamMicTest.tsx:238 — current
    useEffect(() => {
      if (permissionState !== 'granted' || !selectedDevice) return;
      setCameraNotice(getCameraNotice(preferredCameraRef.current, selectedDevice));
      switchCamera(selectedDevice);
    }, [selectedDevice, permissionState, switchCamera]);

`switchCamera` depends on `devices` (`:234`), and `requestPermissions` calls
`setDevices(cameras)` at `:190` **after** attaching a stream — so `switchCamera`
gets a new identity, the effect re-runs, and a fully working 1080p stream is torn
down and renegotiated for no reason.

Finally, `switchCamera` has no request-ordering guard: two quick device changes
can settle out of order, leaving the older stream in `streamRef.current` and the
wrong `camera_used` written to the store.

## Target

### Calibration — own the stream in a local variable and a cancel flag

    // src/pages/test/Calibration.tsx — target
    let cancelled = false;
    let localStream: MediaStream | null = null;

    const startWebcam = async () => {
      if (!navigator.mediaDevices.getUserMedia) {
        console.error('getUserMedia not supported');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: testData.device_id ? { exact: testData.device_id } : undefined,
            ...SCREENING_VIDEO_CONSTRAINTS,
          },
        });
        // Unmounted while getUserMedia was in flight — release immediately.
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        localStream = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.addEventListener('canplay', handleCanPlay);
        }
      } catch (error) {
        console.error('Webcam start error:', error);
      }
    };

    startWebcam();

    return () => {
      cancelled = true;
      if (videoEl) {
        videoEl.removeEventListener('canplay', handleCanPlay);
        videoEl.srcObject = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
    };

The cleanup now stops what the effect actually acquired rather than what happened
to reach the DOM — the canonical principle from
`react-doctor/effect-needs-cleanup`: _"Release exactly what the effect registers,
on the same lifecycle that registered it."_

### WebcamMicTest — release before acquiring, drop the `devices` dep, guard ordering

    // src/pages/test/WebcamMicTest.tsx — target
    const switchRequestRef = useRef(0);
    const devicesRef = useRef<MediaDeviceInfo[]>([]);

    // Keep the ref in step with state so switchCamera does not depend on `devices`.
    useEffect(() => {
      devicesRef.current = devices;
    }, [devices]);

    const switchCamera = useCallback(
      async (deviceId: string) => {
        if (!deviceId) return;
        const requestId = ++switchRequestRef.current;
        // Release the camera BEFORE re-acquiring it: holding two streams for one
        // device makes getUserMedia reject with NotReadableError on low-end hardware.
        stopAnalysis();
        stopCurrentStream();
        try {
          const newStream = await acquireStream(deviceId);
          // A newer switch superseded this one while it was in flight.
          if (requestId !== switchRequestRef.current) {
            newStream.getTracks().forEach(t => t.stop());
            return;
          }
          streamRef.current = newStream;
          attachStreamToVideo(newStream);
          startAnalysis(newStream);
          updateTestStoreWithCamera(deviceId, getCameraLabel(deviceId, devicesRef.current));
        } catch (err) {
          if (requestId !== switchRequestRef.current) return;
          console.error('Error switching camera:', err);
          setError('Error switching camera device');
        }
      },
      [
        acquireStream,
        stopCurrentStream,
        stopAnalysis,
        attachStreamToVideo,
        startAnalysis,
        updateTestStoreWithCamera,
      ]
    );

With `devices` gone from the dependency array, `switchCamera` keeps a stable
identity and the effect at `:238` no longer re-fires when `setDevices` runs.

Additionally, skip the redundant switch when the requested device is already the
live one:

    // src/pages/test/WebcamMicTest.tsx:238 — target
    useEffect(() => {
      if (permissionState !== 'granted' || !selectedDevice) return;
      setCameraNotice(getCameraNotice(preferredCameraRef.current, selectedDevice));
      // The permission handlers already acquired a stream for this device.
      const liveDeviceId = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
      if (liveDeviceId === selectedDevice) return;
      switchCamera(selectedDevice);
    }, [selectedDevice, permissionState, switchCamera]);

## Repo conventions to follow

- `useCallback` for handlers with an explicit dependency array; refs are named
  `<thing>Ref` (`streamRef`, `preferredCameraRef`, `rafRef`).
- The `mounted` flag pattern already exists in this file at
  `src/pages/test/WebcamMicTest.tsx:143-176` — imitate it; the new `cancelled`
  flag in Calibration is the same idea.
- `stopCurrentStream` / `stopAnalysis` already exist in `WebcamMicTest`; reuse
  them, do not inline track-stopping.
- Comments in this repo explain _why_, not _what_. Keep the two explanatory
  comments above; do not add narration.

## Steps

1. In `src/pages/test/Calibration.tsx`, inside the effect that ends at `:177`,
   add the `cancelled` and `localStream` locals, the post-await `cancelled`
   check, and replace the cleanup body exactly as shown in Target.
2. In `src/pages/test/WebcamMicTest.tsx`, add `switchRequestRef` and
   `devicesRef` next to the existing refs, plus the small effect that syncs
   `devicesRef` from `devices`.
3. Replace `switchCamera` (`:211-236`) with the Target version — note the
   reordering of `stopCurrentStream()`/`stopAnalysis()` to _before_ the await,
   the request-ordering guard, and the removal of `devices` from the deps.
4. Replace the effect at `:238-242` with the Target version (early-return when
   the live track already matches `selectedDevice`).
5. Re-read the diff and remove unrelated churn. There is no test framework in
   this repo (`package.json` scripts are `dev`, `build`, `lint`, `typecheck`,
   `preview`), so do not add test files.

## Boundaries

- Do NOT change public component APIs or user-visible copy.
- Do NOT add dependencies.
- Do NOT touch `useFaceDetector.ts` — that is plan 002.
- Do NOT change `SCREENING_VIDEO_CONSTRAINTS` or any capture resolution.
- STOP if the code has drifted from the baseline described in plans/README.md and report the drift.
  instead of improvising.

## Verification

- **Mechanical**:
  - `npx react-doctor@latest --scope changed` — no new diagnostics, score not
    lower than the 51 baseline.
  - `npm run typecheck` and `npm run lint` both clean.
- **Behavior check** (needs a real camera):
  1. Go to `/test/fillup`, start a session, land on `/test/webcam-test`. Confirm
     the preview appears and — in DevTools Network/console — that only **one**
     `getUserMedia` negotiation happens per device, not two. The camera indicator
     light must not blink off/on right after the preview appears.
  2. With a second camera attached, switch devices in the dropdown several times
     quickly. The preview must follow the final selection with no "Error
     switching camera device" toast, and `camera_used` in the store must match
     the last selected device.
  3. Advance to `/test/calibration`, then immediately press the browser Back
     button and confirm the exit dialog. The OS camera indicator light must go
     **off** within a second of leaving. Repeat 3× in a row and confirm the next
     entry into calibration still gets a picture (this is the `NotReadableError`
     regression path).
- **Done when**: no new diagnostics, typecheck/lint clean, the camera light
  reliably turns off on leaving calibration, and repeated device switches never
  surface the switch-error toast.
