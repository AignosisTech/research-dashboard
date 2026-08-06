import type { NavigateFunction } from 'react-router';

import { isAxiosError } from 'axios';
import { toast } from 'sonner';

import { createResearchSession, type ResearchSessionCreatePayload } from '@/lib/api/research';
import { rememberCampOrigin, resolveCampId } from '@/lib/camps/campOrigin';
import {
  db,
  deletePendingGroundTruth,
  deletePendingSession,
  estimateOfflineStorageUsage,
  getCampChild,
  getPendingSession,
  putPendingGroundTruth,
  putPendingSession,
  updateCampChild,
} from '@/lib/offline/db';
import { getUidFromToken } from '@/lib/offline/jwt';
import { canTakeTestOffline } from '@/lib/offline/resourceCache';
import { deriveSessionId } from '@/lib/offline/session';
import type { StimulusLanguage } from '@/lib/offline/stimulus';
import { processSyncQueue } from '@/lib/offline/syncManager';
import type { CampChildRecord, CampRecord } from '@/lib/offline/types';
import { useAuthStore } from '@/stores/authStore';
import { useTestStore } from '@/stores/testStore';

/** Passed through Fillup via location.state so the flow knows its roster origin. */
export interface CampChildNavState {
  id: string;
  campId: string;
  campName: string;
}

/**
 * Where leaving the test flow (finish, quit, error) should land: back on the
 * camp the session was started from, or the dashboard for non-camp sessions.
 * Falls back to the per-tab camp origin so an exit still finds its roster when
 * the store was already wiped (see campOrigin.ts).
 */
export function testExitPath(campId: string | null | undefined): string {
  const resolved = resolveCampId(campId);
  return resolved ? `/camps/${resolved}` : '/dashboard';
}

/**
 * Legacy entry: camps created before camp-level settings existed have nothing
 * to build a session from, so they go through the normal intake form with the
 * identity fields prefilled and locked.
 */
export function startCampRecording(
  navigate: NavigateFunction,
  child: CampChildRecord,
  campName: string
): void {
  navigate('/test/fillup', {
    state: {
      prefill: {
        patientName: child.name,
        dateOfBirth: child.dob,
        patientGender: child.gender,
        guardianPhone: child.guardianPhone,
      },
      campChild: {
        id: child.id,
        campId: child.campId,
        campName,
      } satisfies CampChildNavState,
    },
  });
}

/**
 * One-tap entry for camps with stored settings: creates the session directly
 * from the roster row + camp settings (no intake form, no instructions page)
 * and jumps to the webcam check. Mirrors Fillup's handleNextClick, including
 * the offline path and the network-drop fallback.
 *
 * Returns true when the flow was entered (navigation happened).
 */
export async function startCampChildSession(
  navigate: NavigateFunction,
  child: CampChildRecord,
  camp: CampRecord
): Promise<boolean> {
  const settings = camp.settings;
  if (!settings) {
    startCampRecording(navigate, child, camp.name);
    return true;
  }

  const patientInfo = {
    name: child.name,
    dob: child.dob,
    gender: child.gender,
    guardian_phone: child.guardianPhone,
  };
  const metadata = {
    camera_resolution: { width: 0, height: 0 },
    screen_resolution: { width: 0, height: 0 },
    screen_size_inch: settings.screenSizeInch,
    video_language: settings.videoLanguage,
    camera_used: '',
  };
  // Canonical play order: version 1 before version 2.
  const orderedVersions = [...settings.stimulusVersions].sort();
  const clientSessionId = crypto.randomUUID();
  const payload: ResearchSessionCreatePayload = {
    patient_info: patientInfo,
    metadata,
    data_usage_consent: settings.dataUsageConsent,
    stimulus_versions: orderedVersions,
    client_session_id: clientSessionId,
    camp_name: camp.name,
  };

  const startTest = async (sessionId: string) => {
    // Link + queue ground truth before entering the flow so a crash mid-test
    // still leaves the linkage (and queued label) intact.
    await linkChildToSession(child.id, clientSessionId, sessionId);
    const { resetTestData, setTestData } = useTestStore.getState();
    resetTestData();
    setTestData({
      session_id: sessionId,
      patient_info: patientInfo,
      metadata,
      data_usage_consent: settings.dataUsageConsent,
      stimulus_versions: orderedVersions,
      video_count: orderedVersions.length,
      run_queue: orderedVersions.map((_, index) => index + 1),
      current_video_index: 1,
      questionnaire_completed: false,
      uploaded_test_ids: [],
      camp_child_id: child.id,
      camp_id: camp.id,
      camp_name: camp.name,
    });
    rememberCampOrigin(camp.id);
    // Camp mode skips the instructions page — the operator runs many children
    // back-to-back and has read it long ago. Straight to the system check.
    navigate('/test/webcam-test');
  };

  const startOffline = async (): Promise<boolean> => {
    const token = useAuthStore.getState().token;
    const uid = getUidFromToken(token, true);
    const prereqs = await canTakeTestOffline({
      hasAuth: !!token,
      uid,
      videoLanguage: settings.videoLanguage as StimulusLanguage,
      stimulusVersions: orderedVersions,
    });
    if (!prereqs.ok || !uid) {
      toast.error(
        `This device isn't prepared for offline tests (missing: ${
          prereqs.missing.join(', ') || 'authentication'
        }). Tap "Prepare this device" on the dashboard while online.`
      );
      return false;
    }

    const storage = await estimateOfflineStorageUsage();
    if (storage.percent !== null && storage.percent >= 95) {
      toast.error(
        'This device is out of storage. Connect to the internet to sync pending tests before recording more.'
      );
      return false;
    }

    const sessionId = await deriveSessionId(uid, clientSessionId);
    const now = Date.now();
    await putPendingSession({
      session_id: sessionId,
      client_session_id: clientSessionId,
      uid,
      payload,
      video_count: orderedVersions.length,
      stimulus_versions: orderedVersions,
      syncStatus: 'pending',
      lastError: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    toast.info('No internet — this test will be saved on this device and synced later.');
    await startTest(sessionId);
    return true;
  };

  try {
    if (!navigator.onLine) {
      return await startOffline();
    }
    const session = await createResearchSession(payload);
    await startTest(session.session_id);
    return true;
  } catch (error) {
    // Create died without an HTTP response (network dropped mid-call) — fall
    // back to the offline path, same as starting offline outright.
    if (isAxiosError(error) && !error.response) {
      console.warn('[camps] Session create unreachable, falling back to offline', error);
      return await startOffline();
    }
    console.error('[camps] Failed to create research session', error);
    toast.error(error instanceof Error ? error.message : 'Failed to start research session');
    return false;
  }
}

/**
 * Called once the session id is known (online create or offline derivation —
 * same id either way). Links the roster row to its session and queues the
 * roster ground truth; the sync engine applies it as soon as the session
 * exists server-side, so online and offline share one code path.
 */
export async function linkChildToSession(
  campChildId: string,
  clientSessionId: string,
  sessionId: string
): Promise<void> {
  const child = await getCampChild(campChildId);
  if (!child) return;

  // Re-record: a previous session that never captured anything (no uploads
  // queued, creation never confirmed) is a stale empty shell — drop its queue
  // rows so it doesn't sync a session nobody recorded against. Anything the
  // server confirmed, or that has captured runs, is left strictly alone.
  if (child.sessionId && child.sessionId !== sessionId) {
    const [staleSession, staleUploads] = await Promise.all([
      getPendingSession(child.sessionId),
      db.pendingUploads.where('session_id').equals(child.sessionId).count(),
    ]);
    if (staleSession && staleSession.syncStatus !== 'created' && staleUploads === 0) {
      await deletePendingSession(child.sessionId);
      await deletePendingGroundTruth(child.sessionId);
    }
  }

  await updateCampChild(campChildId, {
    clientSessionId,
    sessionId,
  });

  if (child.groundTruth) {
    await putPendingGroundTruth({
      session_id: sessionId,
      uid: child.uid,
      campChildId: child.id,
      payload: child.groundTruth,
      syncStatus: 'pending',
      lastError: null,
      attempts: 0,
      createdAt: Date.now(),
    });
    // Online: applied within seconds of the session create. Offline: waits in
    // the queue like everything else.
    void processSyncQueue();
  }
}

/** Mark the roster row recorded — called when the child's test flow completes. */
export async function markCampChildRecorded(campChildId: string): Promise<void> {
  await updateCampChild(campChildId, { status: 'recorded', recordedAt: Date.now() });
}
