import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import dogImage from '@/assets/dog_face.webp';
import { Circle } from '@/components/test/Circle';
import { ExitTestDialog, useExitTestDialog } from '@/components/test/ExitTestDialog';
import { testExitPath } from '@/lib/camps/recordFlow';
import { autismFacts } from '@/lib/constants/facts';
import { SCREENING_VIDEO_CONSTRAINTS } from '@/lib/media/screeningRecording';
import {
  encryptCalibrationData,
  encryptMirrorFramePayload,
  encryptPassword,
} from '@/lib/utils/encryptionUtils';
import { requestFullscreen } from '@/lib/utils/fullscreen';
import { useTestStore } from '@/stores/testStore';

/** Matches former ~33ms interval; second sample uses `t + 1/fps` like the old buffer indexing. */
const CALIBRATION_FRAME_PAIR_FPS = 30;
const DEV_SHOW_CLICKED_FRAMES = import.meta.env.DEV;

async function dataUrlToBlobUrl(dataUrl: string): Promise<string> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export const Calibration = () => {
  const [factIndex, setFactIndex] = useState(0);
  const newFactInterval = 7000;

  const [startTime, setStartTime] = useState<number | null>(null);
  const capturedFramesRef = useRef<Array<Array<{ timestamp: number; frame: string }>>>([]);
  const clickInFlightRef = useRef(false);
  const [isCircleVisible, setIsCircleVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isTestCompleted, setIsTestCompleted] = useState(false);

  const [currentCircleIndex, setCurrentCircleIndex] = useState(0);
  const [parentDimensions, setParentDimensions] = useState<[number, number]>([0, 0]);
  const [screenDimensions, setScreenDimensions] = useState<[number, number]>([0, 0]);
  const [videoReady, setVideoReady] = useState(false);

  const [videoResolution, setVideoResolution] = useState<[number, number]>([640, 480]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const testData = useTestStore(s => s.testData);
  const setTestData = useTestStore(s => s.setTestData);
  const navigate = useNavigate();
  const { showExitDialog, closeDialog } = useExitTestDialog();

  const [circleCoordinates, setCircleCoordinates] = useState<[number, number][]>([]);

  // Calculate screen dimensions and coordinates
  useEffect(() => {
    const dogSize = 100;
    const margin = dogSize / 2 + 20;

    const updateDimensions = () => {
      const screenWidth = document.documentElement.clientWidth;
      const screenHeight = document.documentElement.clientHeight;

      setScreenDimensions([screenWidth, screenHeight]);

      const newCoordinates: [number, number][] = [
        [screenWidth / 2, screenHeight / 2], // center
        [margin, margin], // left top
        [margin, screenHeight / 2], // left mid
        [margin, screenHeight - margin], // left bottom
        [screenWidth - margin, margin], // right top
        [screenWidth - margin, screenHeight / 2], // right mid
        [screenWidth - margin, screenHeight - margin], // right bottom
        [screenWidth / 2, margin], // mid top
        [screenWidth / 2, screenHeight - margin], // mid bottom
      ];

      setCircleCoordinates(newCoordinates);
    };

    // Initial calculation
    updateDimensions();

    // Update on window resize
    window.addEventListener('resize', updateDimensions);

    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  useEffect(() => {
    if (isLoading) {
      const factInterval = setInterval(() => {
        setFactIndex(prevIndex => (prevIndex + 1) % autismFacts.length);
      }, newFactInterval);

      return () => clearInterval(factInterval);
    }
  }, [isLoading]);

  useEffect(() => {
    if (!testData || !testData.patient_info.name || testData.patient_info.name === '') {
      // Camp one-tap sessions never visit the intake form — send them back to
      // their roster instead of a blank Fillup.
      navigate(testData?.camp_id ? testExitPath(testData.camp_id) : '/test/fillup', {
        replace: true,
      });
      return;
    }
    // Deep-linking into calibration without redoing the webcam check would carry
    // stale per-run capture state (matters for run 2, where it was just reset).
    if (!testData.webcam_test_completed) {
      navigate('/test/webcam-test', { replace: true });
    }
  }, [testData, navigate]);

  useEffect(() => {
    if (parentRef.current) {
      const { clientWidth, clientHeight } = parentRef.current;
      setParentDimensions([clientWidth, clientHeight]);
    }
  }, [screenDimensions]);

  useEffect(() => {
    if (isTestCompleted) return;

    const videoEl = videoRef.current;

    const handleCanPlay = () => {
      setVideoReady(true);
      if (videoRef.current) {
        setVideoResolution([videoRef.current.videoWidth, videoRef.current.videoHeight]);
      }
    };

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
  }, [testData.device_id, isTestCompleted]);

  useEffect(() => {
    if (isTestCompleted) return;

    const audio = new Audio('/dog_bark.wav');
    audio.loop = true;
    audioRef.current = audio;

    audio.play().catch(() => {
      // Ignore AbortError - happens when cleanup runs while play() is resolving
    });

    return () => {
      audio.pause();
      audio.currentTime = 0;
      audio.src = '';
      audioRef.current = null;
    };
  }, [isTestCompleted]);

  const handleNextButtonClick = async () => {
    const { encrypted_aes_password, metadata } = testData;
    if (!encrypted_aes_password || !metadata.video_language) {
      console.error('Missing required test data');
      toast.error('Missing required test data');
      navigate(testData.camp_id ? testExitPath(testData.camp_id) : '/test/fillup', {
        replace: true,
      });
      return;
    }

    try {
      await requestFullscreen();
    } catch {
      // Already fullscreen or not supported, continue anyway
    }

    navigate('/test/video');
  };

  const captureFrame = (): string | null => {
    if (isTestCompleted) return null;

    if (canvasRef.current && videoRef.current) {
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return null;

      if (canvas.width !== videoRef.current.videoWidth) {
        canvas.width = videoRef.current.videoWidth;
      }
      if (canvas.height !== videoRef.current.videoHeight) {
        canvas.height = videoRef.current.videoHeight;
      }

      context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg');
    } else {
      return null;
    }
  };

  const waitTwoAnimationFrames = () =>
    new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

  const captureFramePairForClick = async (
    t: number
  ): Promise<Array<{ timestamp: number; frame: string }>> => {
    const first = captureFrame();
    await waitTwoAnimationFrames();
    const second = captureFrame();
    const dt = 1 / CALIBRATION_FRAME_PAIR_FPS;
    return [
      { timestamp: t, frame: first ?? '' },
      { timestamp: t + dt, frame: second ?? '' },
    ];
  };

  const logCapturedFramePair = async (
    clickIndex: number,
    frames: Array<{ timestamp: number; frame: string }>
  ) => {
    if (!DEV_SHOW_CLICKED_FRAMES) return;
    const framePreviews = await Promise.all(
      frames.map(async ({ timestamp, frame }, frameIndex) => ({
        frameIndex,
        timestamp,
        blobUrl: frame ? await dataUrlToBlobUrl(frame) : null,
      }))
    );
    console.log(`[Calibration][DEV] Click ${clickIndex} frame previews`, framePreviews);
    // Revoke immediately after logging so DEV previews don't leak blob URLs
    for (const preview of framePreviews) {
      if (preview.blobUrl) URL.revokeObjectURL(preview.blobUrl);
    }
  };

  const handleCircleClick = async () => {
    if (clickInFlightRef.current) return;
    clickInFlightRef.current = true;
    try {
      if (currentCircleIndex === 0) {
        if (!videoReady) {
          return;
        }
        setStartTime(Date.now());
        const frames = await captureFramePairForClick(0);
        capturedFramesRef.current.push(frames);
        await logCapturedFramePair(currentCircleIndex, frames);
        setCurrentCircleIndex(currentCircleIndex + 1);
        return;
      }

      if (currentCircleIndex < circleCoordinates.length - 1) {
        if (startTime) {
          const t = (Date.now() - startTime) / 1000;
          const frames = await captureFramePairForClick(t);
          capturedFramesRef.current.push(frames);
          await logCapturedFramePair(currentCircleIndex, frames);
        }
        setCurrentCircleIndex(currentCircleIndex + 1);
        return;
      }

      // LAST CLICK ON THE DOG: capture BEFORE tearing down the webcam/audio,
      // otherwise the second frame of the pair (captured ~2 rAFs later) races
      // with the webcam effect cleanup that nulls srcObject.
      if (startTime) {
        const t = (Date.now() - startTime) / 1000;
        const frames = await captureFramePairForClick(t);
        capturedFramesRef.current.push(frames);
        await logCapturedFramePair(currentCircleIndex, frames);
      }

      try {
        if (audioRef.current) {
          audioRef.current.loop = false;
          audioRef.current.currentTime = 0;
          audioRef.current.pause();
          audioRef.current.src = '';
        }
      } catch (err) {
        console.error('Error stopping audio:', err);
      }
      setIsTestCompleted(true);
      setIsCircleVisible(false);

      const capturedByPoint = capturedFramesRef.current;
      const calibrationPoints: Array<{
        point: { x: number; y: number; final: boolean };
        frames: Array<{ timestamp: number; frame: string }>;
      }> = [];

      for (let i = 0; i < capturedByPoint.length; i++) {
        calibrationPoints.push({
          point: {
            x: circleCoordinates[i][0],
            y: circleCoordinates[i][1],
            final: i === capturedByPoint.length - 1,
          },
          frames: capturedByPoint[i],
        });
      }

      // ENCRYPTION STARTS HERE (calibration points)
      async function processAndSendData() {
        setIsLoading(true);

        try {
          const aesKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

          const encryptedCalibrationPoints = await encryptCalibrationData(
            calibrationPoints,
            aesKey
          ).catch(error => {
            console.error('Failed to encrypt calibration points:', error);
            throw error;
          });

          let encryptedMirrorFrameBase64: string | null = null;
          if (testData.mirror_frame_data_url) {
            encryptedMirrorFrameBase64 = await encryptMirrorFramePayload(
              { mirror_frame: testData.mirror_frame_data_url },
              aesKey
            ).catch(error => {
              console.error('Failed to encrypt mirror frame:', error);
              throw error;
            });
          }

          const calibrationEncryptedAesKey = await encryptPassword(aesKey).catch(error => {
            console.error('Failed to encrypt password:', error);
            throw error;
          });

          setTestData({
            encrypted_aes_password: calibrationEncryptedAesKey,
            metadata: {
              ...testData.metadata,
              camera_resolution: {
                width: videoResolution[0],
                height: videoResolution[1],
              },
              screen_resolution: {
                width: screenDimensions[0],
                height: screenDimensions[1],
              },
            },
            encrypted_calibration_points: new Blob([encryptedCalibrationPoints], {
              type: 'application/octet-stream',
            }),
            encrypted_mirror_frame: encryptedMirrorFrameBase64
              ? new Blob([encryptedMirrorFrameBase64], { type: 'application/octet-stream' })
              : null,
            mirror_frame_data_url: null,
          });
        } catch (error) {
          console.error('Processing error:', error);
          navigate(testData.camp_id ? testExitPath(testData.camp_id) : '/test/fillup', {
            replace: true,
          });
        }
      }

      processAndSendData()
        .catch(err => {
          console.log(err);
        })
        .finally(() => {
          setIsLoading(false);
          console.log('Calibration data processed successfully');
        });
    } finally {
      clickInFlightRef.current = false;
    }
  };

  return (
    <div
      id="parent-container"
      ref={parentRef}
      className={`dark flex flex-col w-screen h-screen ${!isCircleVisible ? 'bg-background' : 'bg-white'}`}
    >
      {isCircleVisible &&
        parentDimensions[0] > 0 &&
        parentDimensions[1] > 0 &&
        circleCoordinates.length > 0 &&
        currentCircleIndex < circleCoordinates.length && (
          <Circle
            onClickHandler={handleCircleClick}
            x={circleCoordinates[currentCircleIndex][0]}
            y={circleCoordinates[currentCircleIndex][1]}
            radius={50}
            imageUrl={dogImage}
          />
        )}

      {!isCircleVisible &&
        (isLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center h-full bg-background">
            <div className="flex items-end flex-1 mt-[200px]">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
            </div>
            <p className="flex mt-5 mb-[100px] font-extralight text-primary text-[30px]">
              Please wait calibrating...
            </p>
            <p className="flex items-end flex-1 text-center mb-[100px] text-primary max-w-[80%]">
              {autismFacts[factIndex].fact}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center h-full bg-background">
            <button
              className="rounded-xl bg-primary px-10 py-4 text-lg font-semibold text-primary-foreground transition-all hover:bg-primary/90 hover:scale-105"
              onClick={handleNextButtonClick}
            >
              Start Test
            </button>
          </div>
        ))}

      <div className="w-0 h-0 overflow-hidden">
        <video ref={videoRef} autoPlay playsInline muted></video>
      </div>
      <canvas ref={canvasRef} className="flex-1 hidden" />

      <ExitTestDialog isOpen={showExitDialog} onClose={closeDialog} />
    </div>
  );
};
