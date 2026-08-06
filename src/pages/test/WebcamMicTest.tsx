import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ExitTestDialog, useExitTestDialog } from '@/components/test/ExitTestDialog';
import { SCREENING_VIDEO_CONSTRAINTS } from '@/lib/media/screeningRecording';
import { requestFullscreen } from '@/lib/utils/fullscreen';
import { useTestStore } from '@/stores/testStore';

import { CameraDeviceSelect, MicrophoneTestSection, WebcamPreview } from './components';
import { useAudioAnalyser } from './hooks/useAudioAnalyser';
import { useLightingCheck } from './hooks/useLightingCheck';
import type { PermissionState } from './types/webcamTest';
import { useFaceDetector } from './useFaceDetector';
import { findPreferredCamera, getCameraLabel, getCameraNotice } from './utils/cameraUtils';

import './webcam-test.css';

const SHOW_DETECTION_DEBUG_PANEL = false;

const WEBCAM_UI = {
  english: {
    title: 'Webcam & Microphone Test',
    subtitle: 'Test your camera and microphone before proceeding.',
    permissionInitial: 'Click below to enable camera access',
    permissionRequesting: 'Requesting camera permission...',
    permissionDenied: 'Camera access denied. Please retry.',
    allowAccess: 'Allow Camera & Microphone Access',
    requestingPermissions: 'Requesting Permissions...',
    startCalibration: 'Start Calibration',
    positionFace: 'Position face in ellipse to continue',
    fixLighting: 'Fix room lighting to continue',
    completeChecks: 'Position face and fix lighting to continue',
    retryPermissions: 'Retry Permissions',
    micTitle: 'Microphone Test',
    micSpeak: 'Speak into the microphone and the volume level will be displayed below:',
    micAfterPermission: 'Microphone access will be enabled after granting permissions.',
  },
  hindi: {
    title: 'वेबकैम और माइक्रोफोन टेस्ट',
    subtitle: 'आगे बढ़ने से पहले अपने कैमरे और माइक्रोफोन का परीक्षण करें।',
    permissionInitial: 'कैमरा एक्सेस चालू करने के लिए नीचे क्लिक करें',
    permissionRequesting: 'कैमरा अनुमति का अनुरोध हो रहा है...',
    permissionDenied: 'कैमरा एक्सेस अस्वीकृत। कृपया पुनः प्रयास करें।',
    allowAccess: 'कैमरा और माइक्रोफोन एक्सेस की अनुमति दें',
    requestingPermissions: 'अनुमति का अनुरोध हो रहा है...',
    startCalibration: 'कैलिब्रेशन शुरू करें',
    positionFace: 'जारी रखने के लिए चेहरे को अंडाकार में रखें',
    fixLighting: 'जारी रखने के लिए कमरे की रोशनी ठीक करें',
    completeChecks: 'जारी रखने के लिए चेहरा और रोशनी दोनों ठीक करें',
    retryPermissions: 'अनुमति पुनः आज़माएं',
    micTitle: 'माइक्रोफोन टेस्ट',
    micSpeak: 'माइक्रोफोन में बोलें और नीचे वॉल्यूम स्तर दिखेगा:',
    micAfterPermission: 'अनुमति देने के बाद माइक्रोफोन एक्सेस चालू हो जाएगा।',
  },
} as const;

function getPermissionStatusText(permissionState: PermissionState, lang: string): string {
  const t = lang === 'hindi' ? WEBCAM_UI.hindi : WEBCAM_UI.english;
  switch (permissionState) {
    case 'initial':
      return t.permissionInitial;
    case 'requesting':
      return t.permissionRequesting;
    case 'denied':
      return t.permissionDenied;
    default:
      return '';
  }
}

export function WebcamMicTest() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mirrorCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const preferredCameraRef = useRef<MediaDeviceInfo | null>(null);
  const switchRequestRef = useRef(0);
  const devicesRef = useRef<MediaDeviceInfo[]>([]);

  const [error, setError] = useState('');
  const [permissionState, setPermissionState] = useState<PermissionState>('initial');
  const [cameraNotice, setCameraNotice] = useState('');
  const [selectedDevice, setSelectedDevice] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const setTestData = useTestStore(s => s.setTestData);
  const videoLanguage = useTestStore(s => s.testData.metadata.video_language) || 'english';
  const t = videoLanguage === 'hindi' ? WEBCAM_UI.hindi : WEBCAM_UI.english;
  const navigate = useNavigate();
  const { showExitDialog, closeDialog } = useExitTestDialog();

  const { volume, startAnalysis, stopAnalysis } = useAudioAnalyser();
  const faceDetector = useFaceDetector(videoRef, permissionState === 'granted', videoLanguage);
  const lighting = useLightingCheck(videoRef, permissionState === 'granted', videoLanguage);
  const canStartCalibration = faceDetector.isSuccess && lighting.isStableGood;

  const stopCurrentStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const attachStreamToVideo = useCallback((stream: MediaStream) => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(e => console.warn('Video play prevented:', e));
    }
  }, []);

  const updateTestStoreWithCamera = useCallback(
    (deviceId: string, cameraLabel: string) => {
      setTestData(prev => ({
        ...prev,
        device_id: deviceId,
        metadata: { ...prev.metadata, camera_used: cameraLabel },
      }));
    },
    [setTestData]
  );

  const acquireStream = useCallback(async (deviceId?: string): Promise<MediaStream> => {
    const videoConfig = deviceId
      ? { deviceId: { exact: deviceId }, ...SCREENING_VIDEO_CONSTRAINTS }
      : SCREENING_VIDEO_CONSTRAINTS;
    return navigator.mediaDevices.getUserMedia({
      video: videoConfig,
      audio: true,
    });
  }, []);

  const initializePreview = useCallback(
    (stream: MediaStream, cameras: MediaDeviceInfo[], initialDeviceId: string) => {
      streamRef.current = stream;
      attachStreamToVideo(stream);
      startAnalysis(stream);
      const preferred = findPreferredCamera(cameras);
      preferredCameraRef.current = preferred;
      setCameraNotice(getCameraNotice(preferred, initialDeviceId));
      updateTestStoreWithCamera(initialDeviceId, getCameraLabel(initialDeviceId, cameras));
    },
    [attachStreamToVideo, startAnalysis, updateTestStoreWithCamera]
  );

  useEffect(() => {
    let mounted = true;

    async function checkExistingPermissions() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const deviceList = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = deviceList.some(
          d => d.label && (d.kind === 'videoinput' || d.kind === 'audioinput')
        );
        if (!mounted || !hasLabels) return;

        const cameras = deviceList.filter((d): d is MediaDeviceInfo => d.kind === 'videoinput');
        setDevices(cameras);
        const preferred = findPreferredCamera(cameras);
        preferredCameraRef.current = preferred;
        const initialDeviceId = preferred?.deviceId ?? cameras[0]?.deviceId ?? '';
        setSelectedDevice(initialDeviceId);

        const stream = await acquireStream(initialDeviceId || undefined);
        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        initializePreview(stream, cameras, initialDeviceId);
        setPermissionState('granted');
      } catch {
        // Permission not yet granted; user will click to request
      }
    }

    checkExistingPermissions();
    return () => {
      mounted = false;
    };
  }, [acquireStream, initializePreview]);

  const requestPermissions = useCallback(async () => {
    setPermissionState('requesting');
    setError('');
    try {
      const stream = await acquireStream();
      streamRef.current = stream;
      attachStreamToVideo(stream);
      setPermissionState('granted');

      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const cameras = deviceList.filter((d): d is MediaDeviceInfo => d.kind === 'videoinput');
      setDevices(cameras);

      if (cameras.length === 0) throw new Error('No camera devices found');

      const preferred = findPreferredCamera(cameras);
      preferredCameraRef.current = preferred;
      const activeTrack = stream.getVideoTracks()[0];
      const activeDeviceId = activeTrack.getSettings().deviceId;
      const initialDeviceId = preferred?.deviceId ?? activeDeviceId ?? cameras[0].deviceId;

      setSelectedDevice(initialDeviceId);
      setCameraNotice(getCameraNotice(preferred, initialDeviceId));
      startAnalysis(stream);
      updateTestStoreWithCamera(initialDeviceId, getCameraLabel(initialDeviceId, cameras));
    } catch (err) {
      console.error('Permission request failed:', err);
      setPermissionState('denied');
      setError('Error: Please allow access to your webcam and microphone and refresh the page');
    }
  }, [acquireStream, attachStreamToVideo, startAnalysis, updateTestStoreWithCamera]);

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

  useEffect(() => {
    if (permissionState !== 'granted' || !selectedDevice) return;
    setCameraNotice(getCameraNotice(preferredCameraRef.current, selectedDevice));
    // The permission handlers already acquired a stream for this device, but
    // they ran before the <video> element existed — it only mounts once the
    // state is 'granted'. Re-attach the live stream instead of renegotiating.
    const liveStream = streamRef.current;
    const liveDeviceId = liveStream?.getVideoTracks()[0]?.getSettings().deviceId;
    if (liveStream && liveDeviceId === selectedDevice) {
      attachStreamToVideo(liveStream);
      return;
    }
    switchCamera(selectedDevice);
  }, [selectedDevice, permissionState, switchCamera, attachStreamToVideo]);

  useEffect(() => {
    return () => {
      stopCurrentStream();
      stopAnalysis();
    };
  }, [stopCurrentStream, stopAnalysis]);

  const captureMirrorFrameDataUrl = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = mirrorCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      return null;
    }
    const context = canvas.getContext('2d');
    if (!context) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg');
  }, []);

  const handleStartCalibration = useCallback(async () => {
    const mirrorDataUrl = captureMirrorFrameDataUrl();
    if (!mirrorDataUrl) {
      console.warn('[WebcamMicTest] Mirror frame capture failed; continuing without mirror image');
      setTestData({ webcam_test_completed: true });
    } else {
      if (import.meta.env.DEV) {
        console.log('[WebcamMicTest] Mirror frame captured:', mirrorDataUrl);
      }
      setTestData({ mirror_frame_data_url: mirrorDataUrl, webcam_test_completed: true });
    }

    try {
      await requestFullscreen();
    } catch {
      setError(
        'Failed to enter fullscreen mode. Please press F11 or use browser controls to enter fullscreen.'
      );
      return;
    }
    navigate('/test/calibration');
  }, [navigate, captureMirrorFrameDataUrl, setTestData]);

  return (
    <div className="dark flex min-h-screen flex-col items-center justify-center bg-background py-10 text-foreground">
      <header className="absolute left-6 top-6">
        <div className="relative inline-block">
          <div className="absolute inset-0 rounded-lg bg-linear-to-r from-blue-500 to-primary opacity-60 blur-lg" />
          <h1 className="relative z-10 font-montserrat text-2xl font-semibold text-foreground">
            Aignosis
          </h1>
        </div>
      </header>

      <main className="flex w-full max-w-5xl flex-col items-center px-6">
        <section className="mb-8 text-center">
          <h1 className="mb-4 text-4xl font-bold text-foreground">{t.title}</h1>
          <p className="text-lg text-muted-foreground">{t.subtitle}</p>
        </section>

        <div className="mb-8 flex w-full flex-col items-stretch gap-8 lg:flex-row lg:items-flex-start lg:gap-10">
          <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card p-8 shadow-2xl">
            <CameraDeviceSelect
              devices={devices}
              selectedDeviceId={selectedDevice}
              onDeviceChange={setSelectedDevice}
            />

            <div className="mb-6 flex min-h-80 flex-1 flex-col items-center justify-center sm:min-h-[400px] lg:min-h-[540px]">
              <WebcamPreview
                videoRef={videoRef}
                faceDetector={faceDetector}
                permissionState={permissionState}
                permissionStatusText={getPermissionStatusText(permissionState, videoLanguage)}
                language={videoLanguage}
                lightingStatus={lighting.status}
                lightingMessage={lighting.message}
                lightingTip={lighting.tip}
                lightingDebug={lighting.debug}
                showDebugPanel={SHOW_DETECTION_DEBUG_PANEL}
              />
            </div>

            {faceDetector.error && (
              <div className="mb-4 flex w-full items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                <span>{faceDetector.error}</span>
                <button
                  type="button"
                  onClick={() => faceDetector.retryLoadModels()}
                  className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-500/20 dark:text-amber-300"
                >
                  Retry loading models
                </button>
              </div>
            )}

            {cameraNotice && (
              <div className="mb-4 w-full rounded-md border border-border bg-card px-4 py-2 text-xs font-medium text-foreground">
                {cameraNotice}
              </div>
            )}

            {permissionState === 'initial' && (
              <button
                type="button"
                onClick={requestPermissions}
                className="mb-6 rounded-lg bg-linear-to-r from-primary to-primary/80 px-6 py-3 font-montserrat font-semibold text-primary-foreground shadow-lg transition-all duration-200 hover:from-primary/90 hover:to-primary/70"
              >
                {t.allowAccess}
              </button>
            )}

            {permissionState === 'requesting' && (
              <button
                type="button"
                disabled
                className="mb-6 cursor-not-allowed rounded-lg bg-muted px-6 py-3 font-montserrat font-semibold text-muted-foreground opacity-50"
              >
                {t.requestingPermissions}
              </button>
            )}

            {permissionState === 'granted' && (
              <button
                type="button"
                onClick={handleStartCalibration}
                disabled={!canStartCalibration}
                className="mb-6 transform rounded-lg bg-linear-to-r from-primary to-primary/80 px-6 py-3 font-montserrat font-semibold text-primary-foreground shadow-lg transition-colors duration-200 hover:from-primary/90 hover:to-primary/70 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {canStartCalibration
                  ? t.startCalibration
                  : faceDetector.isSuccess && lighting.status !== 'good'
                    ? t.fixLighting
                    : !faceDetector.isSuccess && lighting.status === 'good'
                      ? t.positionFace
                      : t.completeChecks}
              </button>
            )}

            {permissionState === 'denied' && (
              <button
                type="button"
                onClick={requestPermissions}
                className="mb-6 rounded-lg bg-linear-to-r from-red-600 to-red-700 px-6 py-3 font-montserrat font-semibold text-white shadow-lg transition-all duration-200 hover:from-red-700 hover:to-red-800"
              >
                {t.retryPermissions}
              </button>
            )}

            <MicrophoneTestSection
              volume={volume}
              permissionState={permissionState}
              error={error}
              translatedLabels={{
                micTitle: t.micTitle,
                micSpeak: t.micSpeak,
                micAfterPermission: t.micAfterPermission,
              }}
            />
          </section>
        </div>
      </main>

      <canvas ref={mirrorCanvasRef} className="hidden" aria-hidden />

      <ExitTestDialog isOpen={showExitDialog} onClose={closeDialog} />
    </div>
  );
}
