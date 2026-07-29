import Dexie, { type EntityTable } from 'dexie';

import type {
  CampChildRecord,
  CampRecord,
  DraftRunRecord,
  MetadataCacheEntry,
  PendingAssessmentRecord,
  PendingGroundTruthRecord,
  PendingQuestionnaireRecord,
  PendingSessionRecord,
} from './types';

/**
 * The single Dexie instance for the 'aignosis-research' database.
 *
 * pendingUploads / pendingUploadBlobs (v1–v2) belong to the local-first upload
 * safety net in src/lib/uploads/pendingUploads.ts, which imports this instance.
 * v3 adds the offline subsystem tables. Both modules MUST share this one
 * instance — two Dexie instances declaring different schemas against the same
 * database name race each other into VersionError.
 */

/** Small, listable upload record — mirrors pendingUploads.ts documentation. */
export interface PendingUploadMeta {
  /** `${session_id}:${video_index}` — mirrors the server's idempotency key. */
  id: string;
  session_id: string;
  video_index: number;
  /** Child's name, for display in the pending-uploads indicator. */
  patient_name: string;
  encrypted_aes_password: string;
  data_usage_consent: boolean;
  /** Per-run metadata JSON (includes video_version). */
  metadata: Record<string, unknown>;
  size_bytes: number;
  created_at: number;
  attempts: number;
  last_error: string | null;
  last_attempt_at: number | null;
}

/** The heavy half — loaded only when an upload is actually attempted. */
export interface PendingUploadBlobs {
  id: string;
  video_file: Blob;
  video_encrypted_aes_key: Blob;
  encrypted_calibration_points: Blob | null;
  encrypted_mirror_frame: Blob | null;
}

export const db = new Dexie('aignosis-research') as Dexie & {
  pendingUploads: EntityTable<PendingUploadMeta, 'id'>;
  pendingUploadBlobs: EntityTable<PendingUploadBlobs, 'id'>;
  pendingSessions: EntityTable<PendingSessionRecord, 'session_id'>;
  pendingQuestionnaires: EntityTable<PendingQuestionnaireRecord, 'session_id'>;
  pendingAssessments: EntityTable<PendingAssessmentRecord, 'id'>;
  metadataCache: EntityTable<MetadataCacheEntry, 'key'>;
  draftRuns: EntityTable<DraftRunRecord, 'id'>;
  camps: EntityTable<CampRecord, 'id'>;
  campChildren: EntityTable<CampChildRecord, 'id'>;
  pendingGroundTruths: EntityTable<PendingGroundTruthRecord, 'session_id'>;
};

// v1 stored blobs inline on pendingUploads; v2 splits them out.
db.version(1).stores({ pendingUploads: 'id, session_id, created_at' });
db.version(2)
  .stores({
    pendingUploads: 'id, session_id, created_at',
    pendingUploadBlobs: 'id',
  })
  .upgrade(async tx => {
    const legacyRows = await tx.table('pendingUploads').toArray();
    for (const row of legacyRows) {
      if (!row.video_file) continue;
      await tx.table('pendingUploadBlobs').put({
        id: row.id,
        video_file: row.video_file,
        video_encrypted_aes_key: row.video_encrypted_aes_key,
        encrypted_calibration_points: row.encrypted_calibration_points ?? null,
        encrypted_mirror_frame: row.encrypted_mirror_frame ?? null,
      });
      await tx.table('pendingUploads').put({
        id: row.id,
        session_id: row.session_id,
        video_index: row.video_index,
        patient_name: row.patient_name ?? '',
        encrypted_aes_password: row.encrypted_aes_password,
        data_usage_consent: row.data_usage_consent,
        metadata: row.metadata,
        size_bytes: row.video_file?.size ?? 0,
        created_at: row.created_at,
        attempts: 0,
        last_error: null,
        last_attempt_at: null,
      });
    }
  });
// v3 adds the offline subsystem: offline-created sessions, queued
// questionnaires/assessments, cached reference data, and draft recordings.
db.version(3).stores({
  pendingUploads: 'id, session_id, created_at',
  pendingUploadBlobs: 'id',
  pendingSessions: 'session_id, uid, syncStatus, createdAt',
  pendingQuestionnaires: 'session_id, uid, syncStatus',
  pendingAssessments: 'id, session_id, uid, syncStatus',
  metadataCache: 'key, fetchedAt',
  draftRuns: 'id, uid, updatedAt',
});
// v4 adds Camp Mode: device-local camps + rosters, and the queue of
// roster-derived ground truths applied after a session syncs.
db.version(4).stores({
  pendingUploads: 'id, session_id, created_at',
  pendingUploadBlobs: 'id',
  pendingSessions: 'session_id, uid, syncStatus, createdAt',
  pendingQuestionnaires: 'session_id, uid, syncStatus',
  pendingAssessments: 'id, session_id, uid, syncStatus',
  metadataCache: 'key, fetchedAt',
  draftRuns: 'id, uid, updatedAt',
  camps: 'id, uid, createdAt',
  campChildren: 'id, campId, uid, sessionId, createdAt',
  pendingGroundTruths: 'session_id, uid, syncStatus',
});

// --- pending sessions -------------------------------------------------------

export async function putPendingSession(record: PendingSessionRecord): Promise<void> {
  await db.pendingSessions.put(record);
}

export async function getPendingSession(
  sessionId: string
): Promise<PendingSessionRecord | undefined> {
  return db.pendingSessions.get(sessionId);
}

export async function updatePendingSession(
  sessionId: string,
  patch: Partial<PendingSessionRecord>
): Promise<void> {
  await db.pendingSessions.update(sessionId, { ...patch, updatedAt: Date.now() });
}

export async function listPendingSessionsForUid(uid: string): Promise<PendingSessionRecord[]> {
  return db.pendingSessions.where('uid').equals(uid).sortBy('createdAt');
}

/** Sessions the server has not confirmed yet (creation still owed). */
export async function listUncreatedSessionsForUid(uid: string): Promise<PendingSessionRecord[]> {
  const all = await listPendingSessionsForUid(uid);
  return all.filter(s => s.syncStatus !== 'created');
}

/** Set of session_ids whose server-side creation is still owed (any uid). */
export async function getUncreatedSessionIds(): Promise<Set<string>> {
  const all = await db.pendingSessions.toArray();
  return new Set(all.filter(s => s.syncStatus !== 'created').map(s => s.session_id));
}

export async function deletePendingSession(sessionId: string): Promise<void> {
  await db.pendingSessions.delete(sessionId);
}

// --- pending questionnaires -------------------------------------------------

export async function putPendingQuestionnaire(record: PendingQuestionnaireRecord): Promise<void> {
  await db.pendingQuestionnaires.put(record);
}

export async function listPendingQuestionnaires(
  uid: string
): Promise<PendingQuestionnaireRecord[]> {
  return db.pendingQuestionnaires.where('uid').equals(uid).sortBy('createdAt');
}

export async function deletePendingQuestionnaire(sessionId: string): Promise<void> {
  await db.pendingQuestionnaires.delete(sessionId);
}

// --- pending assessments ----------------------------------------------------

export async function putPendingAssessment(record: PendingAssessmentRecord): Promise<void> {
  await db.pendingAssessments.put(record);
}

export async function listPendingAssessments(uid: string): Promise<PendingAssessmentRecord[]> {
  return db.pendingAssessments.where('uid').equals(uid).sortBy('updatedAtLocal');
}

export async function listPendingAssessmentsForSession(
  sessionId: string
): Promise<PendingAssessmentRecord[]> {
  return db.pendingAssessments.where('session_id').equals(sessionId).toArray();
}

export async function deletePendingAssessment(id: string): Promise<void> {
  await db.pendingAssessments.delete(id);
}

// --- camps ------------------------------------------------------------------

export async function putCamp(record: CampRecord): Promise<void> {
  await db.camps.put(record);
}

export async function getCamp(campId: string): Promise<CampRecord | undefined> {
  return db.camps.get(campId);
}

export async function listCampsForUid(uid: string): Promise<CampRecord[]> {
  const camps = await db.camps.where('uid').equals(uid).sortBy('createdAt');
  return camps.reverse();
}

/**
 * Delete a camp and its roster. Deliberately does NOT touch pendingSessions /
 * pendingUploads / pendingQuestionnaires / pendingGroundTruths — those are
 * keyed by session_id and any recording captured at the camp must still sync.
 */
export async function deleteCampCascade(campId: string): Promise<void> {
  await db.transaction('rw', db.camps, db.campChildren, async () => {
    await db.campChildren.where('campId').equals(campId).delete();
    await db.camps.delete(campId);
  });
}

// --- camp children ----------------------------------------------------------

export async function bulkPutCampChildren(records: CampChildRecord[]): Promise<void> {
  await db.campChildren.bulkPut(records);
}

export async function getCampChild(id: string): Promise<CampChildRecord | undefined> {
  return db.campChildren.get(id);
}

export async function listCampChildren(campId: string): Promise<CampChildRecord[]> {
  return db.campChildren.where('campId').equals(campId).sortBy('rowIndex');
}

export async function updateCampChild(id: string, patch: Partial<CampChildRecord>): Promise<void> {
  await db.campChildren.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteCampChild(id: string): Promise<void> {
  await db.campChildren.delete(id);
}

// --- pending ground truths --------------------------------------------------

export async function putPendingGroundTruth(record: PendingGroundTruthRecord): Promise<void> {
  await db.pendingGroundTruths.put(record);
}

export async function listPendingGroundTruths(uid: string): Promise<PendingGroundTruthRecord[]> {
  return db.pendingGroundTruths.where('uid').equals(uid).sortBy('createdAt');
}

export async function updatePendingGroundTruth(
  sessionId: string,
  patch: Partial<PendingGroundTruthRecord>
): Promise<void> {
  await db.pendingGroundTruths.update(sessionId, patch);
}

export async function deletePendingGroundTruth(sessionId: string): Promise<void> {
  await db.pendingGroundTruths.delete(sessionId);
}

// --- metadata cache ---------------------------------------------------------

export async function getMetadataCacheEntry<T>(
  key: MetadataCacheEntry['key']
): Promise<MetadataCacheEntry<T> | undefined> {
  return db.metadataCache.get(key) as Promise<MetadataCacheEntry<T> | undefined>;
}

export async function putMetadataCacheEntry<T>(
  key: MetadataCacheEntry['key'],
  value: T
): Promise<void> {
  await db.metadataCache.put({
    key,
    value,
    fetchedAt: Date.now(),
  });
}

// --- storage ----------------------------------------------------------------

/**
 * Ask the browser to mark this origin's storage as persistent so it is not
 * silently evicted under storage pressure. Without this, Cache Storage (face
 * models, stimulus videos, test assets) and IndexedDB are "best-effort" and the
 * browser may clear them at any time — which surfaces as a device that was
 * "prepared for offline" suddenly reporting that models need to be downloaded
 * again. Best-effort and idempotent: returns the resulting persisted state and
 * never throws. Requires a user gesture / engagement on some browsers, so we
 * call it from the explicit "Prepare this device" action.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist || !navigator.storage.persisted) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function estimateOfflineStorageUsage(): Promise<{
  usage: number;
  quota: number;
  percent: number | null;
}> {
  if (!navigator.storage?.estimate) {
    return { usage: 0, quota: 0, percent: null };
  }
  const est = await navigator.storage.estimate();
  const usage = est.usage ?? 0;
  const quota = est.quota ?? 0;
  const percent = quota > 0 ? Math.round((usage / quota) * 100) : null;
  return { usage, quota, percent };
}

// --- draft runs (crash recovery journal) ------------------------------------

export const draftRunId = (sessionId: string, videoIndex: number) => `${sessionId}:${videoIndex}`;

export type DraftRunMeta = {
  id: string;
  uid: string;
  mimeType: string;
  chunkCount: number;
  updatedAt: number;
  patientName?: string;
};

export async function getDraftRun(id: string): Promise<DraftRunRecord | undefined> {
  return db.draftRuns.get(id);
}

/** Metadata only — does not load chunk Blobs into the caller. */
export async function getDraftRunMetasForUid(uid: string): Promise<DraftRunMeta[]> {
  const drafts = await db.draftRuns.where('uid').equals(uid).sortBy('updatedAt');
  return drafts.map(d => ({
    id: d.id,
    uid: d.uid,
    mimeType: d.mimeType,
    chunkCount: d.chunks.length,
    updatedAt: d.updatedAt,
    patientName: d.patientName,
  }));
}

export async function deleteDraftRun(id: string): Promise<void> {
  await db.draftRuns.delete(id);
}

export async function deleteDraftRunsOlderThan(ms: number): Promise<number> {
  const cutoff = Date.now() - ms;
  const all = await db.draftRuns.toArray();
  const stale = all.filter(d => d.updatedAt < cutoff);
  await db.draftRuns.bulkDelete(stale.map(d => d.id));
  return stale.length;
}

/**
 * Serializes appendDraftChunk calls per run so concurrent MediaRecorder
 * ondataavailable ticks (every ~2s) can't interleave their get -> push -> put
 * and silently lose a chunk. Each call chains off the previous call's promise
 * for the same run id (catching so one failure doesn't wedge the queue), and
 * the read-modify-write itself runs inside a Dexie transaction for an extra
 * layer of safety against cross-tab / cross-context races.
 */
const draftAppendQueues = new Map<string, Promise<unknown>>();

export async function appendDraftChunk(
  id: string,
  chunk: Blob,
  mimeType: string,
  uid: string,
  patientName?: string
): Promise<void> {
  const previous = draftAppendQueues.get(id) ?? Promise.resolve();
  const run: Promise<unknown> = previous
    .catch(() => undefined)
    .then(() =>
      db.transaction('rw', db.draftRuns, async () => {
        const existing = await db.draftRuns.get(id);
        if (existing) {
          existing.chunks.push(chunk);
          existing.mimeType = mimeType;
          existing.updatedAt = Date.now();
          await db.draftRuns.put(existing);
        } else {
          await db.draftRuns.put({
            id,
            uid,
            mimeType,
            chunks: [chunk],
            updatedAt: Date.now(),
            patientName,
          });
        }
      })
    )
    .finally(() => {
      if (draftAppendQueues.get(id) === run) {
        draftAppendQueues.delete(id);
      }
    });
  draftAppendQueues.set(id, run);
  await run;
}
