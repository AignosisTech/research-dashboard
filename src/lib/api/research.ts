import axios from 'axios';

import type { PsychEvalOutcome } from '@/lib/assessments/outcomes';
import type { StoredAssessmentId } from '@/lib/assessments/registry';

import { apiClient } from './client';
import type { QuestionnaireData } from './screening';
import type { ApiResponse, RSAPublicKey } from './types';

/** Stimulus video version: "1" = original AST video, "2" = new AST video. */
export type StimulusVersion = '1' | '2';

export interface ResearchSessionCreatePayload {
  patient_info: {
    name: string;
    dob: string;
    gender: 'male' | 'female' | 'other';
    guardian_phone?: string;
  };
  metadata: {
    camera_resolution: { width: number; height: number };
    screen_resolution: { width: number; height: number };
    video_language: string;
    screen_size_inch: number;
    camera_used: string;
  };
  data_usage_consent: boolean;
  /** Which stimulus versions to capture, in play order. Run N plays stimulus_versions[N-1]. */
  stimulus_versions: StimulusVersion[];
  /**
   * Client-generated UUID for offline-capable creation. When set, the server
   * derives the session document id as sha1(uid:client_session_id)[:32] — the
   * same derivation as deriveSessionId() — and a replayed create is idempotent.
   */
  client_session_id?: string;
  /** Camp label when the session was started from a Camp Mode roster. */
  camp_name?: string;
}

export interface ResearchSessionCreateResponse {
  session_id: string;
  video_count: number;
  stimulus_versions: StimulusVersion[];
}

export interface ResearchTestUploadResponse {
  tid: string;
  session_id: string;
  video_index: number;
}

/** Legacy single-select label, kept so pre-existing sessions still read back. */
export type ClinicianDiagnosis = 'autistic' | 'not_autistic' | 'uncertain';

/**
 * Clinical ground-truth labels for a session — mirror of the middleware
 * GroundTruth schema.
 *
 * `outcome_codes` is the current multi-select label set (same options the
 * psychologists use on the internal dashboard). `clinician_diagnosis` is the
 * superseded single-select field: still read for old sessions, never written.
 */
export interface GroundTruth {
  schema_version: number;
  clinician_diagnosis: ClinicianDiagnosis | null;
  outcome_codes: PsychEvalOutcome[] | null;
  custom_result_paragraph: string | null;
  notes: string | null;
}

/**
 * A saved assessment as returned by the API: the submitted payload plus the
 * server-computed score fields, which vary per instrument (total_score,
 * classification, asd_present, developmental_quotient, ...).
 */
export interface StoredAssessment {
  session_id: string;
  patient_info: AssessmentPatientInfo;
  filled_by?: string;
  updated_at?: string | null;
  [key: string]: unknown;
}

/** Patient info captured on every instrument form. */
export interface AssessmentPatientInfo {
  name: string;
  gender: 'Male' | 'Female' | 'Others';
  date_of_birth: string;
  assessment_date: string;
  age: string | number;
  notes?: string | null;
}

/** One completed capture run, recorded on the session when its upload lands. */
export interface UploadedRun {
  video_index: number;
  video_version: StimulusVersion;
  tid: string;
}

/** Lean row for the dashboard list — only what the table renders. */
export interface ResearchSessionSummary {
  session_id: string;
  status: string;
  stimulus_versions?: StimulusVersion[];
  uploaded_runs: UploadedRun[];
  has_questionnaire: boolean;
  patient_info?: { name?: string; dob?: string };
  ground_truth?: GroundTruth | null;
  camp_name?: string | null;
  /** Which assessments have been filled in — names only; bodies are fetched per-tab. */
  assessment_names?: StoredAssessmentId[];
  created_at?: string | null;
}

/** Full session, fetched only when resuming so the list stays lean. */
export interface ResearchSessionDetail extends ResearchSessionSummary {
  patient_info?: {
    name?: string;
    dob?: string;
    gender?: string;
    guardian_phone?: string;
  };
  metadata?: ResearchSessionCreatePayload['metadata'];
  data_usage_consent?: boolean;
  timestamps?: Record<string, unknown>;
}

export interface UploadProgressPayload {
  percent: number | null;
  loadedMb: number;
}

export type UploadResearchTestDataOptions = {
  onUploadProgress?: (p: UploadProgressPayload) => void;
};

export const createResearchSession = async (
  payload: ResearchSessionCreatePayload
): Promise<ResearchSessionCreateResponse> => {
  const { data } = await apiClient.post<ApiResponse<ResearchSessionCreateResponse>>(
    '/research/session',
    payload
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to create research session');
  }
  return data.details;
};

export interface PaginatedSessions {
  items: ResearchSessionSummary[];
  next_cursor: string | null;
  has_more: boolean;
  count: number;
  /** Only present when include_total was requested. */
  total_count?: number;
}

export interface GetResearchSessionsOptions {
  pageSize?: number;
  lastCursor?: string;
  includeTotal?: boolean;
}

export const getResearchSessions = async (
  options: GetResearchSessionsOptions = {}
): Promise<PaginatedSessions> => {
  const params = new URLSearchParams();
  if (options.pageSize) params.append('page_size', String(options.pageSize));
  if (options.lastCursor) params.append('last_cursor', options.lastCursor);
  if (options.includeTotal) params.append('include_total', 'true');
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  const { data } = await apiClient.get<ApiResponse<PaginatedSessions>>(
    `/research/sessions${suffix}`
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch research sessions');
  }
  // Tolerate a pre-pagination backend that returned only {items}.
  return {
    items: data.details.items ?? [],
    next_cursor: data.details.next_cursor ?? null,
    has_more: data.details.has_more ?? false,
    count: data.details.count ?? data.details.items?.length ?? 0,
    total_count: data.details.total_count,
  };
};

/** Server-side state of an offline-created session, for reconciliation. */
export interface ResearchSyncStatusItem {
  client_session_id: string;
  /** Derived server document id — null when the create never reached the server. */
  session_id: string | null;
  status: string | null;
  uploaded_runs: UploadedRun[];
  has_questionnaire: boolean;
}

/**
 * Reconcile offline-created sessions with the server. uploaded_runs entries are
 * only written after GCS upload success, so a run listed here is safe to drop
 * from the local pending-upload queue.
 */
export const getResearchSyncStatus = async (
  clientSessionIds: string[]
): Promise<ResearchSyncStatusItem[]> => {
  if (clientSessionIds.length === 0) return [];
  const { data } = await apiClient.get<ApiResponse<{ items: ResearchSyncStatusItem[] }>>(
    '/research/sessions/sync-status',
    { params: { client_session_ids: clientSessionIds.join(',') } }
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch sync status');
  }
  return data.details.items;
};

export const getResearchRSAPublicKey = async (): Promise<RSAPublicKey> => {
  const { data } = await apiClient.get<ApiResponse<RSAPublicKey>>('/research/test/rrpk');
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch RSA public key');
  }
  return data.details;
};

/** Fast in-request retries for a transient upload failure. */
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_MS = 2000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Whether a failed upload is worth retrying. Retrying is safe because the
 * endpoint is idempotent per (session_id, video_index): the server derives a
 * deterministic test id from them, so a request that actually landed returns
 * the same tid instead of creating a duplicate test. We only retry failures
 * that look like an interrupted transfer — a dropped connection or client-side
 * timeout (no HTTP response), nginx's 408, a gateway 5xx, or the backend's 400
 * "error parsing the body" (its view of a truncated multipart stream).
 * Validation/auth errors (401, 422, other 400s) are logical failures and must
 * not be retried.
 */
const isTransientUploadError = (error: unknown): boolean => {
  if (axios.isCancel(error)) return false;
  if (!axios.isAxiosError(error)) return false;
  // No HTTP response at all → connection dropped or timed out mid-upload.
  if (!error.response) return true;

  const status = error.response.status;
  if (status === 408 || status === 502 || status === 503 || status === 504) return true;
  if (status === 400) {
    const message = (error.response.data as { message?: string } | undefined)?.message ?? '';
    return /parsing the body/i.test(message);
  }
  return false;
};

const postResearchTestData = async (
  formData: FormData,
  options: UploadResearchTestDataOptions | undefined
): Promise<ResearchTestUploadResponse> => {
  let lastLoadedMb = 0;

  const { data } = await apiClient.post<ApiResponse<ResearchTestUploadResponse>>(
    '/research/test/data',
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 900000,
      onUploadProgress: progressEvent => {
        lastLoadedMb = progressEvent.loaded / 1024 / 1024;
        let percent: number | null = null;
        if (progressEvent.total) {
          percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        }
        options?.onUploadProgress?.({ percent, loadedMb: lastLoadedMb });
      },
    }
  );

  if (!data.success) {
    throw new Error(data.message || 'Failed to upload research test data');
  }

  options?.onUploadProgress?.({ percent: 100, loadedMb: lastLoadedMb });
  return data.details;
};

// Upload one capture run. Retries transient/interrupted uploads a few times
// with exponential backoff + jitter (safe: see isTransientUploadError).
export const uploadResearchTestData = async (
  formData: FormData,
  options?: UploadResearchTestDataOptions
): Promise<ResearchTestUploadResponse> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await postResearchTestData(formData, options);
    } catch (error) {
      if (attempt >= UPLOAD_MAX_ATTEMPTS || !isTransientUploadError(error)) {
        throw error;
      }
      const backoff = UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(
        `[API] Transient upload failure, retrying in ${backoff}ms:`,
        error instanceof Error ? error.message : error
      );
      await delay(backoff);
    }
  }
};

export const getResearchSession = async (sessionId: string): Promise<ResearchSessionDetail> => {
  const { data } = await apiClient.get<ApiResponse<ResearchSessionDetail>>(
    `/research/session/${sessionId}`
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch session');
  }
  return data.details;
};

/** Delete an abandoned session. Server rejects (409) unless it has no uploaded recordings. */
export const deleteResearchSession = async (sessionId: string): Promise<void> => {
  const { data } = await apiClient.delete<ApiResponse>(`/research/session/${sessionId}`);
  if (!data.success) {
    throw new Error(data.message || 'Failed to delete session');
  }
};

export const getSessionGroundTruth = async (sessionId: string): Promise<GroundTruth | null> => {
  const { data } = await apiClient.get<ApiResponse<{ ground_truth: GroundTruth | null }>>(
    `/research/session/${sessionId}/ground-truth`
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch ground truth');
  }
  return data.details.ground_truth;
};

export const putSessionGroundTruth = async (
  sessionId: string,
  payload: GroundTruth
): Promise<void> => {
  const { data } = await apiClient.put<ApiResponse>(
    `/research/session/${sessionId}/ground-truth`,
    payload
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to save ground truth');
  }
};

/**
 * Fetch one assessment. Resolves to null when it has not been filled in yet —
 * the server returns `details: null` rather than a 404 for that case.
 */
export const getSessionAssessment = async <T = StoredAssessment>(
  sessionId: string,
  assessmentId: StoredAssessmentId
): Promise<T | null> => {
  const { data } = await apiClient.get<ApiResponse<T | null>>(
    `/research/session/${sessionId}/assessments/${assessmentId}`
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch assessment');
  }
  return data.details ?? null;
};

/** Fetch every assessment recorded on a session, keyed by assessment id. */
export const getSessionAssessments = async (
  sessionId: string
): Promise<Partial<Record<StoredAssessmentId, StoredAssessment>>> => {
  const { data } = await apiClient.get<
    ApiResponse<{ assessments: Partial<Record<StoredAssessmentId, StoredAssessment>> }>
  >(`/research/session/${sessionId}/assessments`);
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch assessments');
  }
  return data.details.assessments ?? {};
};

/**
 * Create or replace a single assessment. Scoped to one instrument so saving
 * ISAA cannot clobber a concurrently-saved CARS2 — unlike the ground-truth PUT,
 * which replaces the whole map.
 *
 * The server recomputes totals and classifications, so the response is the
 * authoritative record rather than an echo of what was sent.
 */
export const patchSessionAssessment = async <T = StoredAssessment>(
  sessionId: string,
  assessmentId: StoredAssessmentId,
  payload: unknown
): Promise<T> => {
  const { data } = await apiClient.patch<ApiResponse<T>>(
    `/research/session/${sessionId}/assessments/${assessmentId}`,
    payload
  );
  if (!data.success) {
    throw new Error(data.message || 'Failed to save assessment');
  }
  return data.details;
};

export const submitResearchQuestionnaire = async (
  sessionId: string,
  questionnaire: QuestionnaireData
): Promise<void> => {
  const { data } = await apiClient.post<ApiResponse>('/research/questionnaire', {
    session_id: sessionId,
    questionnaire,
  });
  if (!data.success) {
    throw new Error(data.message || 'Failed to submit questionnaire');
  }
};
