import axios from 'axios';

import {
  createResearchSession,
  getSessionGroundTruth,
  patchSessionAssessment,
  putSessionGroundTruth,
  submitResearchQuestionnaire,
} from '@/lib/api/research';
import { queryClient } from '@/lib/react-query/queryClient';
import {
  countPendingUploads,
  flushPendingUploads,
  listPendingUploads,
} from '@/lib/uploads/pendingUploads';
import { useAuthStore } from '@/stores/authStore';

import {
  db,
  deleteDraftRunsOlderThan,
  deletePendingAssessment,
  deletePendingGroundTruth,
  deletePendingQuestionnaire,
  listPendingAssessments,
  listPendingGroundTruths,
  listPendingQuestionnaires,
  listPendingSessionsForUid,
  listUncreatedSessionsForUid,
  updatePendingSession,
} from './db';
import { getUidFromToken } from './jwt';
import type { SyncStatusSnapshot } from './types';

/**
 * Ordered FIFO replay of everything captured offline, mirroring
 * core/dashboard's sync engine. A pass runs strictly in dependency order:
 *
 *   1. session creates   — the upload endpoint 404s on a missing session
 *   2. video-run uploads — via the existing flushPendingUploads() safety net
 *   3. questionnaires    — the server 409s until all runs of a session landed
 *   4. assessments       — independent PATCHes, last-write-wins
 *   5. ground truths     — camp-roster labels, applied once the session exists
 *                          and only while the server's ground_truth is null
 *
 * Single-flight: concurrent calls set `rerunRequested` instead of being
 * dropped, and the running pass loops again when it finishes.
 */

type SyncListener = (snapshot: SyncStatusSnapshot) => void;

const listeners = new Set<SyncListener>();

let isProcessing = false;
// Set by reconcile.ts while it's rewriting records, so a sync pass doesn't
// race it. processSyncQueue defers to it; reconcile.ts checks isSyncProcessing()
// before starting, so the two can never wait on each other.
let reconcileInProgress = false;
let rerunRequested = false;
let pausedForAuth = false;
let lastSyncError: string | null = null;
let onlineHandlerAttached = false;
let onlineHandler: (() => void) | null = null;
let onlineHandlerRefCount = 0;
let backoffUntil = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

function clearBackoffTimer(): void {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

/** True while a sync pass is actively running. */
export function isSyncProcessing(): boolean {
  return isProcessing;
}

/** Used by reconcile.ts to claim/release the shared mutex around record mutation. */
export function setReconcileInProgress(value: boolean): void {
  reconcileInProgress = value;
}

const INITIAL_SNAPSHOT: SyncStatusSnapshot = {
  pendingSessionCount: 0,
  pendingUploadCount: 0,
  pendingQuestionnaireCount: 0,
  pendingAssessmentCount: 0,
  pendingGroundTruthCount: 0,
  failedCount: 0,
  pausedForAuth: false,
  isSyncing: false,
  lastSyncError: null,
};

let snapshot: SyncStatusSnapshot = { ...INITIAL_SNAPSHOT };

function emit(partial?: Partial<SyncStatusSnapshot>) {
  snapshot = { ...snapshot, ...partial };
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function getSyncSnapshot(): SyncStatusSnapshot {
  return snapshot;
}

export function subscribeSyncStatus(listener: SyncListener): () => void {
  listeners.add(listener);
  listener(snapshot);
  return () => listeners.delete(listener);
}

export function resumeSyncAfterAuth(): void {
  pausedForAuth = false;
  lastSyncError = null;
  backoffUntil = 0;
  consecutiveFailures = 0;
  clearBackoffTimer();
  emit({ pausedForAuth: false, lastSyncError: null });
  void processSyncQueue();
}

async function refreshCounts(uid: string): Promise<void> {
  const [sessions, uploadCount, questionnaires, assessments, groundTruths] = await Promise.all([
    listPendingSessionsForUid(uid),
    countPendingUploads(),
    listPendingQuestionnaires(uid),
    listPendingAssessments(uid),
    listPendingGroundTruths(uid),
  ]);
  const uncreated = sessions.filter(s => s.syncStatus !== 'created');
  const failedCount =
    uncreated.filter(s => s.syncStatus === 'failed').length +
    questionnaires.filter(q => q.syncStatus === 'failed').length +
    assessments.filter(a => a.syncStatus === 'failed').length +
    groundTruths.filter(g => g.syncStatus === 'failed').length;
  emit({
    pendingSessionCount: uncreated.length,
    pendingUploadCount: uploadCount,
    pendingQuestionnaireCount: questionnaires.length,
    pendingAssessmentCount: assessments.length,
    pendingGroundTruthCount: groundTruths.length,
    failedCount,
    pausedForAuth,
    isSyncing: isProcessing,
    lastSyncError,
  });
}

function isUnauthorized(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 401;
}

function errorDetail(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { detail?: string; message?: string } | undefined;
    return data?.detail || data?.message || err.message;
  }
  return err instanceof Error ? err.message : 'Sync failed';
}

function scheduleBackoff(): void {
  const delay = Math.min(60_000 * 2 ** Math.min(consecutiveFailures, 4), 300_000);
  consecutiveFailures += 1;
  backoffUntil = Date.now() + delay;
  // Reschedule so sync resumes automatically once the backoff expires,
  // instead of stalling until the app reloads or comes back online.
  clearBackoffTimer();
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void processSyncQueue();
  }, delay);
}

export async function processSyncQueue(options?: { force?: boolean }): Promise<void> {
  if (isProcessing) {
    rerunRequested = true;
    return;
  }
  // Reconcile owns record reads/writes right now; back off and let it finish
  // (it triggers its own processSyncQueue() pass when done).
  if (reconcileInProgress) return;

  isProcessing = true;
  emit({ isSyncing: true });

  try {
    let currentOptions = options;
    for (;;) {
      await runSyncPass(currentOptions);
      if (rerunRequested) {
        rerunRequested = false;
        currentOptions = undefined;
        continue;
      }
      break;
    }
  } finally {
    isProcessing = false;
    emit({ isSyncing: false, pausedForAuth, lastSyncError });
  }
}

async function runSyncPass(options?: { force?: boolean }): Promise<void> {
  const token = useAuthStore.getState().token;

  // Refresh counts before any early return so the badge stays accurate even
  // when offline / paused / signed out — including when the token itself has
  // expired, in which case we still want a uid for local counting purposes
  // even though it's not valid for actually authenticating a sync.
  const countingUid = getUidFromToken(token, true);
  if (countingUid) {
    await refreshCounts(countingUid);
  }

  if (pausedForAuth && !options?.force) {
    emit({ pausedForAuth: true });
    return;
  }
  if (!navigator.onLine) {
    emit({ lastSyncError: 'Offline — will sync when connected.' });
    return;
  }
  if (Date.now() < backoffUntil && !options?.force) {
    return;
  }

  const uid = getUidFromToken(token);
  if (!uid || !token) {
    pausedForAuth = true;
    emit({ pausedForAuth: true, lastSyncError: 'Sign in to sync pending tests.' });
    return;
  }

  let hadFailure = false;

  // 1. Session creates — everything downstream depends on these existing
  const uncreated = await listUncreatedSessionsForUid(uid);
  for (const session of uncreated) {
    if (!navigator.onLine || pausedForAuth) break;
    try {
      const result = await createResearchSession({
        ...session.payload,
        client_session_id: session.client_session_id,
      });
      if (result.session_id !== session.session_id) {
        // Derivation drift between client and server would strand every
        // dependent record — fail loudly rather than sync into the wrong doc.
        throw new Error(
          `Session id mismatch (local ${session.session_id}, server ${result.session_id})`
        );
      }
      await updatePendingSession(session.session_id, {
        syncStatus: 'created',
        lastError: null,
        attempts: session.attempts + 1,
      });
      console.log('[sync] Session created', session.session_id);
    } catch (err) {
      hadFailure = true;
      console.error('[sync] Session create failed', session.session_id, err);
      if (isUnauthorized(err)) {
        pausedForAuth = true;
        lastSyncError = 'Session expired. Sign in to sync pending tests.';
        emit({ pausedForAuth: true, lastSyncError });
        break;
      }
      lastSyncError = errorDetail(err);
      await updatePendingSession(session.session_id, {
        syncStatus: 'failed',
        lastError: lastSyncError,
        attempts: session.attempts + 1,
      });
    }
  }

  // 2. Video-run uploads — the existing local-first safety net. It skips runs
  // whose session is still un-created and records per-row errors itself.
  if (navigator.onLine && !pausedForAuth) {
    const flushResult = await flushPendingUploads();
    if (flushResult && flushResult.failed > 0) {
      hadFailure = true;
      const rows = await listPendingUploads();
      const authFailure = rows.some(r => r.last_error?.includes('Signed out'));
      if (authFailure) {
        pausedForAuth = true;
        lastSyncError = 'Session expired. Sign in to sync pending tests.';
        emit({ pausedForAuth: true, lastSyncError });
      }
    }
  }

  // 3. Questionnaires — only once the session exists and has no runs still
  // queued locally (the server 409s "Uploads incomplete" otherwise).
  if (navigator.onLine && !pausedForAuth) {
    const questionnaires = await listPendingQuestionnaires(uid);
    const remainingUploads = await listPendingUploads();
    const sessionsWithQueuedUploads = new Set(remainingUploads.map(r => r.session_id));
    const stillUncreated = new Set((await listUncreatedSessionsForUid(uid)).map(s => s.session_id));

    for (const q of questionnaires) {
      if (!navigator.onLine || pausedForAuth) break;
      if (q.syncStatus === 'failed') continue; // permanent conflict — needs a human
      if (stillUncreated.has(q.session_id)) continue;
      if (sessionsWithQueuedUploads.has(q.session_id)) continue;
      try {
        await submitResearchQuestionnaire(q.session_id, q.questionnaire);
        await deletePendingQuestionnaire(q.session_id);
        console.log('[sync] Questionnaire synced', q.session_id);
      } catch (err) {
        console.error('[sync] Questionnaire failed', q.session_id, err);
        if (isUnauthorized(err)) {
          pausedForAuth = true;
          lastSyncError = 'Session expired. Sign in to sync pending tests.';
          emit({ pausedForAuth: true, lastSyncError });
          break;
        }
        const detail = errorDetail(err);
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 409 && /uploads incomplete/i.test(detail)) {
          // Runs still landing (possibly from another device) — retry later.
          hadFailure = true;
          lastSyncError = detail;
        } else if (status === 409) {
          // A different questionnaire already exists server-side. Keep the row,
          // surface it — never silently discard captured data.
          await db_markQuestionnaireFailed(q.session_id, detail, q.attempts);
        } else {
          hadFailure = true;
          lastSyncError = detail;
        }
      }
    }
  }

  // 4. Assessments — independent last-write-wins PATCHes
  if (navigator.onLine && !pausedForAuth) {
    const assessments = await listPendingAssessments(uid);
    const stillUncreated = new Set((await listUncreatedSessionsForUid(uid)).map(s => s.session_id));
    for (const a of assessments) {
      if (!navigator.onLine || pausedForAuth) break;
      if (stillUncreated.has(a.session_id)) continue;
      try {
        await patchSessionAssessment(a.session_id, a.assessment_name, a.payload);
        await deletePendingAssessment(a.id);
        queryClient.invalidateQueries({ queryKey: ['sessionAssessments', a.session_id] });
        console.log('[sync] Assessment synced', a.id);
      } catch (err) {
        console.error('[sync] Assessment failed', a.id, err);
        if (isUnauthorized(err)) {
          pausedForAuth = true;
          lastSyncError = 'Session expired. Sign in to sync pending tests.';
          emit({ pausedForAuth: true, lastSyncError });
          break;
        }
        hadFailure = true;
        lastSyncError = errorDetail(err);
        await db_markAssessmentFailed(a.id, lastSyncError, a.attempts);
      }
    }
  }

  // 5. Ground truths — camp-roster labels. Only dependency is the session
  // existing server-side. GET-before-PUT so a manually set label always wins;
  // either way the queue row is consumed, which also makes replays after a
  // crash between PUT and delete harmless.
  if (navigator.onLine && !pausedForAuth) {
    const groundTruths = await listPendingGroundTruths(uid);
    const stillUncreated = new Set((await listUncreatedSessionsForUid(uid)).map(s => s.session_id));
    for (const g of groundTruths) {
      if (!navigator.onLine || pausedForAuth) break;
      if (stillUncreated.has(g.session_id)) continue;
      try {
        const existing = await getSessionGroundTruth(g.session_id);
        if (existing == null) {
          await putSessionGroundTruth(g.session_id, g.payload);
          console.log('[sync] Ground truth applied', g.session_id);
        } else {
          console.log('[sync] Ground truth already set server-side, dropping', g.session_id);
        }
        await deletePendingGroundTruth(g.session_id);
      } catch (err) {
        console.error('[sync] Ground truth failed', g.session_id, err);
        if (isUnauthorized(err)) {
          pausedForAuth = true;
          lastSyncError = 'Session expired. Sign in to sync pending tests.';
          emit({ pausedForAuth: true, lastSyncError });
          break;
        }
        hadFailure = true;
        lastSyncError = errorDetail(err);
        await db.pendingGroundTruths.update(g.session_id, {
          syncStatus: 'failed',
          lastError: lastSyncError,
          attempts: g.attempts + 1,
        });
      }
    }
  }

  await refreshCounts(uid);
  if (!hadFailure) {
    lastSyncError = null;
    consecutiveFailures = 0;
  } else if (!pausedForAuth) {
    scheduleBackoff();
  }

  queryClient.invalidateQueries({ queryKey: ['researchSessions'] });

  try {
    await deleteDraftRunsOlderThan(24 * 60 * 60 * 1000); // 24h draft TTL
  } catch {
    // non-critical
  }
}

// Small helpers kept local so db.ts stays free of sync-status semantics.
async function db_markQuestionnaireFailed(
  sessionId: string,
  error: string,
  attempts: number
): Promise<void> {
  await db.pendingQuestionnaires.update(sessionId, {
    syncStatus: 'failed',
    lastError: error,
    attempts: attempts + 1,
  });
}

async function db_markAssessmentFailed(id: string, error: string, attempts: number): Promise<void> {
  await db.pendingAssessments.update(id, {
    syncStatus: 'failed',
    lastError: error,
    attempts: attempts + 1,
  });
}

export function initSyncManager(): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  void processSyncQueue();

  onlineHandlerRefCount += 1;
  if (!onlineHandlerAttached) {
    onlineHandler = () => {
      backoffUntil = 0;
      clearBackoffTimer();
      void processSyncQueue();
    };
    window.addEventListener('online', onlineHandler);
    onlineHandlerAttached = true;
  }

  return () => {
    onlineHandlerRefCount = Math.max(0, onlineHandlerRefCount - 1);
    if (onlineHandlerRefCount === 0 && onlineHandler) {
      window.removeEventListener('online', onlineHandler);
      onlineHandler = null;
      onlineHandlerAttached = false;
    }
  };
}
