/**
 * Face detection logic from FaceFrame detector.js — Child Screening Validator.
 * Uses face-api tiny detector + 68-point landmarks for front-facing face,
 * ellipse coverage and centre alignment.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import * as faceapi from '@vladmandic/face-api';

import type { FaceDetectorMetrics, FaceDetectorState, FaceMovementHint } from './types/webcamTest';

export type { FaceDetectorMetrics, FaceDetectorState } from './types/webcamTest';

const MODELS_URL = `${import.meta.env.BASE_URL}models`;

const ELLIPSE = { cx: 0.5, cy: 0.5, rx: 173 / 600, ry: 200 / 600 };
const COVERAGE_THRESHOLD = 0.6;
const CENTRE_TOLERANCE = 0.15;
const MIN_SCORE = 0.6;
const MIN_EYE_SEPARATION = 0.05;
const SUCCESS_FRAMES_REQUIRED = 4;
/** ~5 Hz, matching useLightingCheck's cadence */
const DETECT_INTERVAL_MS = 200;

/** Skip the state write when nothing the UI renders actually changed. */
const sameVisibleState = (a: FaceDetectorState, b: FaceDetectorState) =>
  a.status === b.status &&
  a.message === b.message &&
  a.isSuccess === b.isSuccess &&
  a.movementHints.length === b.movementHints.length &&
  a.movementHints.every((hint, i) => hint === b.movementHints[i]);

type WithLandmarks = faceapi.WithFaceLandmarks<
  { detection: faceapi.FaceDetection },
  faceapi.FaceLandmarks68
>;

function centroid(pts: { x: number; y: number }[]) {
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

function isFrontFace(landmarks: faceapi.FaceLandmarks68, videoW: number): boolean {
  const pts = landmarks.positions;
  const leftEyeCenter = centroid(pts.slice(36, 42));
  const rightEyeCenter = centroid(pts.slice(42, 48));
  const eyeDistance = Math.abs(rightEyeCenter.x - leftEyeCenter.x);
  const separation = eyeDistance / videoW;
  const mouthCenter = centroid(pts.slice(48, 68));
  const eyeMidY = (leftEyeCenter.y + rightEyeCenter.y) / 2;
  const mouthBelow = mouthCenter.y > eyeMidY;
  return separation >= MIN_EYE_SEPARATION && mouthBelow;
}

const CAMERA_PREVIEW_MESSAGES = {
  english: {
    initializing: 'Initializing…',
    loadingModels: 'Loading models…',
    positionFace: 'Position your face',
    loadError: 'Failed to load face detection models',
    noFace: 'No face detected',
    faceCamera: 'Please face the camera',
    moveCloser: 'Move closer to camera',
    moveUp: 'move up',
    moveDown: 'move down',
    moveLeft: 'move left',
    moveRight: 'move right',
    centreFace: 'centre face',
    faceSuccess: 'Face Detection Successful',
    holdStill: 'Hold still…',
  },
  hindi: {
    initializing: 'शुरू हो रहा है…',
    loadingModels: 'मॉडल लोड हो रहे हैं…',
    positionFace: 'अपना चेहरा रखें',
    loadError: 'चेहरा पहचान मॉडल लोड करने में विफल',
    noFace: 'कोई चेहरा नहीं मिला',
    faceCamera: 'कृपया कैमरे की ओर देखें',
    moveCloser: 'कैमरे के पास आएं',
    moveUp: 'ऊपर खिसकें',
    moveDown: 'नीचे खिसकें',
    moveLeft: 'बाएं खिसकें',
    moveRight: 'दाएं खिसकें',
    centreFace: 'चेहरा बीच में रखें',
    faceSuccess: 'चेहरा पहचान सफल',
    holdStill: 'स्थिर रहें…',
  },
} as const;

function getT(lang: string) {
  return lang === 'hindi' ? CAMERA_PREVIEW_MESSAGES.hindi : CAMERA_PREVIEW_MESSAGES.english;
}

function buildMovementHints(ox: number, oy: number, coverage: number): FaceMovementHint[] {
  const hints: FaceMovementHint[] = [];
  if (coverage < COVERAGE_THRESHOLD) hints.push('forward');
  if (ox < -CENTRE_TOLERANCE) hints.push('right');
  if (ox > CENTRE_TOLERANCE) hints.push('left');
  if (oy < -CENTRE_TOLERANCE) hints.push('down');
  if (oy > CENTRE_TOLERANCE) hints.push('up');
  return hints;
}

function buildDirectionHint(hints: FaceMovementHint[], lang: string): string {
  const t = getT(lang);
  const parts: string[] = [];
  if (hints.includes('left')) parts.push(t.moveLeft);
  if (hints.includes('right')) parts.push(t.moveRight);
  if (hints.includes('up')) parts.push(t.moveUp);
  if (hints.includes('down')) parts.push(t.moveDown);
  return parts.join(' & ') || t.centreFace;
}

export function useFaceDetector(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  language: string = 'english'
) {
  const t = getT(language);
  const [state, setState] = useState<FaceDetectorState>({
    status: 'loading',
    message: t.initializing,
    metrics: null,
    movementHints: [],
    debug: {
      totalFaces: 0,
      validFaces: 0,
      bestDetectionScore: null,
      frameEvalMs: null,
    },
    isSuccess: false,
    modelsLoaded: false,
    error: null,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const successStreakRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const retryLoadModels = useCallback(() => {
    setReloadToken(n => n + 1);
  }, []);

  const loadModels = useCallback(async () => {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
    ]);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tInit = getT(language);
    let cancelled = false;
    const scheduleLoading = () => {
      setState(prev => ({ ...prev, status: 'loading', message: tInit.loadingModels, error: null }));
    };
    queueMicrotask(scheduleLoading);

    loadModels()
      .then(() => {
        if (cancelled) return;
        setState(prev => ({
          ...prev,
          modelsLoaded: true,
          status: 'no_face',
          message: tInit.positionFace,
          movementHints: [],
          debug: {
            totalFaces: 0,
            validFaces: 0,
            bestDetectionScore: null,
            frameEvalMs: null,
          },
          error: null,
        }));
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[FaceDetector]', err);
        setState(prev => ({
          ...prev,
          status: 'loading',
          message: tInit.initializing,
          movementHints: [],
          debug: {
            totalFaces: 0,
            validFaces: 0,
            bestDetectionScore: null,
            frameEvalMs: null,
          },
          error: err instanceof Error ? err.message : tInit.loadError,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, loadModels, language, reloadToken]);

  useEffect(() => {
    if (!enabled || !state.modelsLoaded || !videoRef.current) return;

    const video = videoRef.current;
    const tCur = getT(language);
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: MIN_SCORE,
    });

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
        if (cancelled) return; // unmounted mid-detection: do not re-arm
        const frameEvalMs = performance.now() - frameStart;

        if (!results || results.length === 0) {
          successStreakRef.current = 0;
          setState(prev => {
            const next: FaceDetectorState = {
              status: 'no_face',
              message: tCur.noFace,
              metrics: null,
              movementHints: [],
              debug: {
                totalFaces: 0,
                validFaces: 0,
                bestDetectionScore: null,
                frameEvalMs,
              },
              isSuccess: false,
              modelsLoaded: true,
              error: null,
            };
            return sameVisibleState(prev, next) ? prev : next;
          });
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        const W2 = video.videoWidth || video.clientWidth;
        const H2 = video.videoHeight || video.clientHeight;

        const validResults = (results as WithLandmarks[]).filter(r =>
          r.landmarks ? isFrontFace(r.landmarks, W2) : false
        );

        if (validResults.length === 0) {
          successStreakRef.current = 0;
          setState(prev => {
            const next: FaceDetectorState = {
              status: 'adjust',
              message: tCur.faceCamera,
              metrics: null,
              movementHints: [],
              debug: {
                totalFaces: results.length,
                validFaces: 0,
                bestDetectionScore: results[0]?.detection.score ?? null,
                frameEvalMs,
              },
              isSuccess: false,
              modelsLoaded: true,
              error: null,
            };
            return sameVisibleState(prev, next) ? prev : next;
          });
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        const best = validResults.reduce((a, b) =>
          a.detection.box.area > b.detection.box.area ? a : b
        );
        const bestDetectionScore = best.detection.score;
        const box = best.detection.box;
        const mirroredX = W2 - box.x - box.width;
        const faceCX = (mirroredX + box.width / 2) / W2;
        const faceCY = (box.y + box.height / 2) / H2;
        const offsetX = faceCX - ELLIPSE.cx;
        const offsetY = faceCY - ELLIPSE.cy;
        const shellW = video.clientWidth || W2;
        const shellH = video.clientHeight || H2;
        const faceAreaPx = box.width * box.height;
        const ellipseAreaPx = Math.PI * (ELLIPSE.rx * shellW) * (ELLIPSE.ry * shellH);
        const coverage = faceAreaPx / ellipseAreaPx;

        const metrics: FaceDetectorMetrics = { coverage, offsetX, offsetY };
        const centred =
          Math.abs(offsetX) <= CENTRE_TOLERANCE && Math.abs(offsetY) <= CENTRE_TOLERANCE;
        const covered = coverage >= COVERAGE_THRESHOLD;
        const movementHints = buildMovementHints(offsetX, offsetY, coverage);

        if (!covered) {
          successStreakRef.current = 0;
          setState(prev => {
            const next: FaceDetectorState = {
              status: 'adjust',
              message: tCur.moveCloser,
              metrics,
              movementHints,
              debug: {
                totalFaces: results.length,
                validFaces: validResults.length,
                bestDetectionScore,
                frameEvalMs,
              },
              isSuccess: false,
              modelsLoaded: true,
              error: null,
            };
            return sameVisibleState(prev, next) ? prev : next;
          });
        } else if (!centred) {
          successStreakRef.current = 0;
          setState(prev => {
            const next: FaceDetectorState = {
              status: 'adjust',
              message: buildDirectionHint(movementHints, language),
              metrics,
              movementHints,
              debug: {
                totalFaces: results.length,
                validFaces: validResults.length,
                bestDetectionScore,
                frameEvalMs,
              },
              isSuccess: false,
              modelsLoaded: true,
              error: null,
            };
            return sameVisibleState(prev, next) ? prev : next;
          });
        } else {
          successStreakRef.current += 1;
          if (successStreakRef.current >= SUCCESS_FRAMES_REQUIRED) {
            setState(prev => {
              const next: FaceDetectorState = {
                status: 'success',
                message: tCur.faceSuccess,
                metrics,
                movementHints: [],
                debug: {
                  totalFaces: results.length,
                  validFaces: validResults.length,
                  bestDetectionScore,
                  frameEvalMs,
                },
                isSuccess: true,
                modelsLoaded: true,
                error: null,
              };
              return sameVisibleState(prev, next) ? prev : next;
            });
          } else {
            setState(prev => ({
              ...prev,
              status: 'adjust',
              message: tCur.holdStill,
              metrics,
              movementHints: [],
              debug: {
                totalFaces: results.length,
                validFaces: validResults.length,
                bestDetectionScore,
                frameEvalMs,
              },
              isSuccess: false,
            }));
          }
        }
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
  }, [enabled, state.modelsLoaded, videoRef, language]);

  return { ...state, retryLoadModels };
}
