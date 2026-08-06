import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { isAxiosError } from 'axios';
import { toast } from 'sonner';

import { ExitTestDialog } from '@/components/test/ExitTestDialog';
import { VideoPlayer } from '@/components/test/VideoPlayer';
import { type StimulusVersion, uploadResearchTestData } from '@/lib/api/research';
import { testExitPath } from '@/lib/camps/recordFlow';
import {
  blobTypeForRecordedChunks,
  createScreeningMediaRecorder,
  SCREENING_VIDEO_CONSTRAINTS,
} from '@/lib/media/screeningRecording';
import { appendDraftChunk, deleteDraftRun, draftRunId } from '@/lib/offline/db';
import { getUidFromToken } from '@/lib/offline/jwt';
import { processSyncQueue } from '@/lib/offline/syncManager';
import type { LocalSubmitResult } from '@/lib/offline/types';
import {
  buildUploadFormData,
  clearUploadInFlight,
  deletePendingUpload,
  markUploadInFlight,
  type PendingUploadBlobs,
  pendingUploadId,
  type PendingUploadMeta,
  savePendingUpload,
} from '@/lib/uploads/pendingUploads';
import { encryptPassword, encryptVideo } from '@/lib/utils/encryptionUtils';
import { useAuthStore } from '@/stores/authStore';
import { useTestStore } from '@/stores/testStore';

/** Walk err.inner/err.cause to spot a storage-full failure wherever Dexie hid it. */
const isQuotaExceededError = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (
      (current instanceof DOMException && current.name === 'QuotaExceededError') ||
      (current instanceof Error && current.name === 'QuotaExceededError')
    ) {
      return true;
    }
    current =
      (current as { inner?: unknown; cause?: unknown }).inner ??
      (current as { cause?: unknown }).cause;
  }
  return false;
};

export const VideoPlayback = () => {
  const testData = useTestStore(s => s.testData);
  const setTestData = useTestStore(s => s.setTestData);
  const addUploadPromise = useTestStore(s => s.addUploadPromise);
  const resetRunCaptureState = useTestStore(s => s.resetRunCaptureState);
  const setUploadProgress = useTestStore(s => s.setUploadProgress);

  const [isRecording, setIsRecording] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);

  const navigate = useNavigate();

  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const webcamRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordedMimeRef = useRef<string>('');
  const videoStreamRef = useRef<MediaStream | null>(null);

  const hasStartedRef = useRef(false);
  const hasEndedRef = useRef(false);
  const isNavigatingRef = useRef(false);

  // Run N plays the stimulus version the researcher selected at fill-up:
  // stimulus_versions[N-1] ("1" = original AST video, "2" = new AST video).
  const stimulusVersion: StimulusVersion =
    testData.stimulus_versions[testData.current_video_index - 1] ?? '2';

  useEffect(() => {
    if (!testData?.patient_info?.name || !testData.session_id) {
      navigate(testExitPath(testData.camp_id), { replace: true });
      return;
    }

    if (!testData.webcam_test_completed) {
      navigate('/test/webcam-test', { replace: true });
    }
  }, [testData, navigate]);

  const stopAllTracks = useCallback(() => {
    if (webcamRef.current?.srcObject) {
      (webcamRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      webcamRef.current.srcObject = null;
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(t => t.stop());
      videoStreamRef.current = null;
    }
  }, []);

  /** Stop recorder handlers first so a final dataavailable cannot fire after abandon. */
  const stopRecorder = useCallback((clearHandlers: boolean) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (clearHandlers) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    mediaRecorderRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    stopRecorder(true);
    recordedChunksRef.current = [];
    recordedMimeRef.current = '';
    stopAllTracks();
  }, [stopAllTracks, stopRecorder]);

  const navigateAfterUpload = useCallback(() => {
    const { current_video_index, run_queue, stimulus_versions } = useTestStore.getState().testData;
    // Advance through the queue rather than counting up, so a resumed session
    // captures only the runs it is actually missing.
    const position = run_queue.indexOf(current_video_index);
    const nextIndex = position >= 0 ? run_queue[position + 1] : undefined;

    if (nextIndex !== undefined) {
      setTestData({ current_video_index: nextIndex });
      resetRunCaptureState();
      const nextVersion = stimulus_versions[nextIndex - 1] ?? '2';
      toast.info(`Next: video ${nextVersion} (${position + 2} of ${run_queue.length})`);
      setTimeout(() => navigate('/test/webcam-test', { replace: true }), 0);
      return;
    }
    setTimeout(() => navigate('/test/questionnaire', { replace: true }), 0);
  }, [navigate, resetRunCaptureState, setTestData]);

  const startRecording = useCallback(async () => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: testData.device_id ? { exact: testData.device_id } : undefined,
          ...SCREENING_VIDEO_CONSTRAINTS,
        },
        audio: true,
      });

      videoStreamRef.current = stream;
      if (webcamRef.current) {
        webcamRef.current.srcObject = stream;
      }

      const recorder = createScreeningMediaRecorder(stream);
      recordedMimeRef.current = recorder.mimeType;
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = e => {
        if (e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
          // Journal each ~2s chunk to IndexedDB so a crash/reload mid-recording
          // is recoverable (DraftRecoveryBanner). Deleted once the encrypted
          // payload is persisted to the pending-upload queue.
          const { session_id, current_video_index, patient_info } =
            useTestStore.getState().testData;
          if (session_id) {
            const uid = getUidFromToken(useAuthStore.getState().token, true) ?? '';
            void appendDraftChunk(
              draftRunId(session_id, current_video_index),
              e.data,
              recorder.mimeType,
              uid,
              patient_info.name
            ).catch(err => {
              console.warn('[VideoPlayback] Draft journal write failed', err);
            });
          }
        }
      };

      recorder.onerror = event => {
        console.error('MediaRecorder error:', event);
        toast.error('Recording error occurred');
      };

      recorder.start(2000);
      setIsRecording(true);
    } catch (err) {
      console.error('Error accessing webcam:', err);
      toast.error('Error accessing webcam. Please ensure you have granted camera permissions.');
      hasStartedRef.current = false;
    }
  }, [testData.device_id]);

  const createUploadPromise = useCallback(
    async (blob: Blob) => {
      if (!testData.session_id) {
        throw new Error('Missing research session');
      }

      const aesKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const encryptedBlob = await encryptVideo(blob, aesKey);
      const encryptedAesKey = await encryptPassword(aesKey);

      // Persist the encrypted payload BEFORE any network I/O so the recording
      // survives a closed tab / failed upload; deleted once the server confirms.
      // (No patient_info sent — the session doc is the SSoT for child info; the
      // name is kept locally only so the pending-uploads indicator can name it.)
      const id = pendingUploadId(testData.session_id, testData.current_video_index);
      const meta: PendingUploadMeta = {
        id,
        session_id: testData.session_id,
        video_index: testData.current_video_index,
        patient_name: testData.patient_info.name,
        encrypted_aes_password: testData.encrypted_aes_password,
        data_usage_consent: testData.data_usage_consent,
        metadata: {
          ...testData.metadata,
          video_version: stimulusVersion,
        },
        size_bytes: encryptedBlob.size,
        created_at: Date.now(),
        attempts: 0,
        last_error: null,
        last_attempt_at: null,
      };
      const blobs: PendingUploadBlobs = {
        id,
        video_file: encryptedBlob,
        video_encrypted_aes_key: new Blob([encryptedAesKey], {
          type: 'application/octet-stream',
        }),
        encrypted_calibration_points: testData.encrypted_calibration_points,
        encrypted_mirror_frame: testData.encrypted_mirror_frame,
      };

      let persisted = false;
      try {
        await savePendingUpload(meta, blobs);
        persisted = true;
        // The encrypted payload is now durable — the plaintext draft journal
        // for this run has served its purpose.
        void deleteDraftRun(id).catch(() => {});
      } catch (persistError) {
        if (isQuotaExceededError(persistError)) {
          toast.error(
            'This device is out of storage — the recording could not be saved locally. It will upload now, but will be lost if the upload fails.'
          );
        }
        // Storage full/unavailable — proceed with the plain upload rather than
        // blocking the flow; we just lose the crash safety net for this run.
        console.warn('[VideoPlayback] Failed to persist pending upload:', persistError);
      }

      // Offline with the payload safely persisted: don't attempt the network
      // at all — the sync engine uploads it when connectivity returns.
      if (!navigator.onLine && persisted) {
        const localResult: LocalSubmitResult = {
          offline: true,
          session_id: meta.session_id,
          video_index: meta.video_index,
        };
        return localResult;
      }

      markUploadInFlight(id);
      try {
        const response = await uploadResearchTestData(buildUploadFormData(meta, blobs), {
          onUploadProgress: setUploadProgress,
        });
        void deletePendingUpload(id).catch(() => {});
        return response;
      } catch (uploadError) {
        // Connection died mid-upload but the payload is persisted — resolve as
        // a local save instead of failing the flow; sync retries it later.
        if (persisted && isAxiosError(uploadError) && !uploadError.response) {
          console.warn('[VideoPlayback] Upload unreachable; keeping local copy for sync');
          const localResult: LocalSubmitResult = {
            offline: true,
            session_id: meta.session_id,
            video_index: meta.video_index,
          };
          return localResult;
        }
        throw uploadError;
      } finally {
        clearUploadInFlight(id);
      }
    },
    [testData, stimulusVersion, setUploadProgress]
  );

  const finalizeUpload = useCallback(
    (blob: Blob) => {
      const uploadPromise = createUploadPromise(blob).then(response => {
        if ('offline' in response) {
          // Saved locally — no server tid yet; the sync engine owns it now.
          // Kick a pass in case connectivity is flaky rather than fully down
          // (a genuinely-offline pass just exits early).
          void processSyncQueue();
          return response;
        }
        setTestData(prev => ({
          uploaded_test_ids: [...prev.uploaded_test_ids, response.tid],
          test_id: response.tid,
        }));
        return response;
      });
      addUploadPromise(uploadPromise);
      cleanup();
      navigateAfterUpload();
    },
    [addUploadPromise, cleanup, createUploadPromise, navigateAfterUpload, setTestData]
  );

  const stopRecordingAndNavigate = useCallback(() => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || (recorder.state !== 'recording' && recorder.state !== 'paused')) {
      if (recordedChunksRef.current.length > 0) {
        try {
          const blob = new Blob(recordedChunksRef.current, {
            type: blobTypeForRecordedChunks(recordedMimeRef.current),
          });
          finalizeUpload(blob);
        } catch (err) {
          console.error('Error preparing upload (no recorder):', err);
          cleanup();
          toast.error('Failed to prepare video upload');
          setTimeout(() => navigate('/test/error', { replace: true }), 0);
        }
      } else {
        cleanup();
        toast.error('Recording failed. Please try again.');
        setTimeout(() => navigate('/test/error', { replace: true }), 0);
      }
      return;
    }

    recorder.onstop = () => {
      try {
        const blob = new Blob(recordedChunksRef.current, {
          type: blobTypeForRecordedChunks(recordedMimeRef.current),
        });
        finalizeUpload(blob);
      } catch (err) {
        console.error('Error preparing upload:', err);
        cleanup();
        toast.error('Failed to prepare video upload');
        setTimeout(() => navigate('/test/error', { replace: true }), 0);
      }
    };

    try {
      recorder.stop();
    } catch (e) {
      console.error('Error stopping recorder:', e);
      if (recordedChunksRef.current.length > 0) {
        try {
          const blob = new Blob(recordedChunksRef.current, {
            type: blobTypeForRecordedChunks(recordedMimeRef.current),
          });
          finalizeUpload(blob);
        } catch (uploadErr) {
          console.error('Error preparing upload after stop failed:', uploadErr);
          cleanup();
          toast.error('Failed to prepare video upload');
          setTimeout(() => navigate('/test/error', { replace: true }), 0);
        }
      } else {
        cleanup();
        toast.error('Recording failed. Please try again.');
        setTimeout(() => navigate('/test/error', { replace: true }), 0);
      }
      return;
    }

    stopAllTracks();
    setIsRecording(false);
  }, [cleanup, finalizeUpload, navigate, stopAllTracks]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.pause();
      setIsRecording(false);
    }
  }, []);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'paused') {
      recorder.resume();
      setIsRecording(true);
    }
  }, []);

  const handlePlay = useCallback(() => {
    if (hasEndedRef.current || isNavigatingRef.current) return;
    if (!hasStartedRef.current) {
      startRecording();
    } else {
      resumeRecording();
    }
  }, [startRecording, resumeRecording]);

  const handlePause = useCallback(() => {
    if (hasEndedRef.current || isNavigatingRef.current) return;
    pauseRecording();
  }, [pauseRecording]);

  const handleEnded = useCallback(() => {
    if (hasEndedRef.current || isNavigatingRef.current) return;
    hasEndedRef.current = true;
    isNavigatingRef.current = true;

    const video = videoPlayerRef.current;
    if (video) {
      video.pause();
      video.autoplay = false;
      video.controls = false;
      video.removeAttribute('src');
      video.load();
    }

    stopRecordingAndNavigate();
  }, [stopRecordingAndNavigate]);

  useEffect(() => {
    window.history.pushState(null, '', window.location.href);

    const onPopState = () => {
      window.history.pushState(null, '', window.location.href);
      setShowExitDialog(true);
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      cleanup();
    };
  }, [cleanup]);

  if (!testData?.patient_info?.name || !testData.session_id) {
    return null;
  }

  return (
    <div className="dark flex min-h-screen flex-col items-center justify-center bg-background">
      <video ref={webcamRef} autoPlay playsInline muted className="hidden" />

      {testData.run_queue.length > 1 && (
        <div className="fixed left-4 top-4 z-50 rounded-full bg-black/50 px-4 py-2 text-sm text-white">
          Video {stimulusVersion} · run{' '}
          {testData.run_queue.indexOf(testData.current_video_index) + 1} of{' '}
          {testData.run_queue.length}
        </div>
      )}

      <VideoPlayer
        ref={videoPlayerRef}
        videoVersion={stimulusVersion}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
      />

      <div className="fixed right-4 top-4 z-50 flex items-center space-x-2 rounded-full bg-black/50 px-4 py-2">
        <div className={`h-3 w-3 rounded-full ${isRecording ? 'bg-red-500' : 'bg-gray-500'}`} />
        <span className="text-sm text-white">{isRecording ? 'Recording' : 'Not Recording'}</span>
      </div>

      <ExitTestDialog
        isOpen={showExitDialog}
        onClose={() => setShowExitDialog(false)}
        onConfirm={cleanup}
      />
    </div>
  );
};
