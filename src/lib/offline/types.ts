import type {
  GroundTruth,
  ResearchSessionCreatePayload,
  StimulusVersion,
} from '@/lib/api/research';
import type { QuestionnaireData } from '@/lib/api/screening';
import type { StoredAssessmentId } from '@/lib/assessments/registry';

export type PendingSyncStatus = 'pending' | 'created' | 'failed';
export type PendingItemStatus = 'pending' | 'failed';

/**
 * A research session created on this device while offline. session_id is the
 * final Firestore document id — sha1(uid:client_session_id)[:32], computed
 * locally with the same derivation the middleware uses — so every downstream
 * record (pending uploads, questionnaire, assessments) can reference it before
 * the create has ever reached the server.
 */
export interface PendingSessionRecord {
  /** Derived 32-hex server document id (primary key). */
  session_id: string;
  /** The client-generated UUID sent to the server for idempotent creation. */
  client_session_id: string;
  uid: string;
  payload: ResearchSessionCreatePayload;
  video_count: number;
  stimulus_versions: StimulusVersion[];
  syncStatus: PendingSyncStatus;
  lastError: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingQuestionnaireRecord {
  session_id: string;
  uid: string;
  questionnaire: QuestionnaireData;
  syncStatus: PendingItemStatus;
  lastError: string | null;
  attempts: number;
  createdAt: number;
}

export interface PendingAssessmentRecord {
  /** `${session_id}:${assessment_name}` — put() on this key = local last-write-wins. */
  id: string;
  session_id: string;
  assessment_name: StoredAssessmentId;
  uid: string;
  payload: unknown;
  syncStatus: PendingItemStatus;
  lastError: string | null;
  attempts: number;
  /** Local edit time; replay is last-write-wins against the server. */
  updatedAtLocal: number;
}

export type MetadataCacheKey =
  | 'rsa_public_key'
  | `sessions_list:${string}`
  | `session_detail:${string}`
  | `assessments:${string}`
  | `hls_cached:${string}`
  | `offline_pack:${string}`;

export interface MetadataCacheEntry<T = unknown> {
  key: MetadataCacheKey;
  value: T;
  fetchedAt: number;
}

export interface OfflinePackMeta {
  ready: boolean;
  downloadedAt: number;
  steps: {
    encryptionKey: boolean;
    faceModels: boolean;
    testAssets: boolean;
    stimulusVideos: boolean;
  };
}

/** MediaRecorder chunk journal for crash recovery of an in-progress run. */
export interface DraftRunRecord {
  /** `${session_id}:${video_index}` */
  id: string;
  uid: string;
  mimeType: string;
  chunks: Blob[];
  updatedAt: number;
  patientName?: string;
}

export interface SyncStatusSnapshot {
  pendingSessionCount: number;
  pendingUploadCount: number;
  pendingQuestionnaireCount: number;
  pendingAssessmentCount: number;
  pendingGroundTruthCount: number;
  failedCount: number;
  pausedForAuth: boolean;
  isSyncing: boolean;
  lastSyncError: string | null;
}

// --- camp mode ---------------------------------------------------------------

/**
 * Test-setup answers collected once at camp creation instead of per child:
 * the whole camp runs on the same device with the same configuration.
 */
export interface CampSettings {
  /** Which stimulus versions to capture per child, in play order. */
  stimulusVersions: StimulusVersion[];
  videoLanguage: 'english' | 'hindi';
  screenSizeInch: number;
  dataUsageConsent: boolean;
}

/**
 * A field data-collection camp. Camps and their rosters are device-local only
 * (IndexedDB) — the server never stores a roster. The only server-side trace is
 * the camp_name tag on sessions recorded from this camp.
 */
export interface CampRecord {
  /** crypto.randomUUID() */
  id: string;
  uid: string;
  name: string;
  location?: string;
  /** Absent only on camps created before settings existed — those fall back to the intake form. */
  settings?: CampSettings;
  createdAt: number;
  updatedAt: number;
}

/**
 * 'pending' | 'recorded' is what we store; "synced" is derived at render time
 * from the pending* queues so the roster can never disagree with the sync
 * engine's actual state.
 */
export type CampChildStatus = 'pending' | 'recorded';

/** One roster row — a child registered for a camp via Excel import. */
export interface CampChildRecord {
  /** crypto.randomUUID() */
  id: string;
  campId: string;
  uid: string;
  /** Original roster order, for stable display. */
  rowIndex: number;
  name: string;
  /** YYYY-MM-DD */
  dob: string;
  gender: 'male' | 'female' | 'other';
  /** '' when the roster did not provide one. */
  guardianPhone: string;
  /** Pre-built payload from the roster's Ground Truth column; null if absent. */
  groundTruth: GroundTruth | null;
  notes: string;
  status: CampChildStatus;
  /** Set when a recording is started for this child. */
  clientSessionId?: string;
  /** Derived/server session id — links the child to its research session. */
  sessionId?: string;
  recordedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Roster ground truth waiting to be written to the child's session. Applied by
 * the sync engine once the session exists server-side, and only if the server's
 * ground_truth is still null (a manual label always wins).
 */
export interface PendingGroundTruthRecord {
  /** Session id (primary key) — one roster ground truth per session. */
  session_id: string;
  uid: string;
  campChildId: string;
  payload: GroundTruth;
  syncStatus: PendingItemStatus;
  lastError: string | null;
  attempts: number;
  createdAt: number;
}

/** Resolved value of an upload promise that was saved locally instead of sent. */
export interface LocalSubmitResult {
  offline: true;
  session_id: string;
  video_index: number;
}
