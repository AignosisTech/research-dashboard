import { isAxiosError } from 'axios';

import {
  getResearchSession,
  getResearchSessions,
  type ResearchSessionDetail,
  type ResearchSessionSummary,
  type StimulusVersion,
  type UploadedRun,
} from '@/lib/api/research';
import { listPendingUploads } from '@/lib/uploads/pendingUploads';
import { useAuthStore } from '@/stores/authStore';

import {
  getMetadataCacheEntry,
  getPendingSession,
  listUncreatedSessionsForUid,
  putMetadataCacheEntry,
} from './db';
import { getUidFromToken } from './jwt';
import type { PendingSessionRecord } from './types';

/** Status used for sessions that exist only on this device so far. */
export const LOCAL_SESSION_STATUS = 'LOCAL';

/** Marker tid for a run recorded on this device but not yet uploaded. */
export const LOCAL_RUN_TID = 'local-pending';

const isNetworkFailure = (err: unknown): boolean =>
  !navigator.onLine || (isAxiosError(err) && !err.response);

/**
 * Runs sitting in the local pending-upload queue, per session. Merged into
 * uploaded_runs for display/resume purposes so an offline-recorded run reads
 * as captured — without this, the dashboard would offer to re-record (and
 * thereby overwrite) a recording that is only waiting for connectivity.
 */
async function localPendingRunsBySession(): Promise<Map<string, UploadedRun[]>> {
  const rows = await listPendingUploads();
  const bySession = new Map<string, UploadedRun[]>();
  for (const row of rows) {
    const runs = bySession.get(row.session_id) ?? [];
    runs.push({
      video_index: row.video_index,
      video_version: (row.metadata.video_version as StimulusVersion) ?? '2',
      tid: LOCAL_RUN_TID,
    });
    bySession.set(row.session_id, runs);
  }
  return bySession;
}

function mergeLocalRuns(uploaded: UploadedRun[], local: UploadedRun[] | undefined): UploadedRun[] {
  if (!local?.length) return uploaded;
  const extras = local.filter(l => !uploaded.some(u => u.video_index === l.video_index));
  return [...uploaded, ...extras];
}

function pendingToSummary(record: PendingSessionRecord): ResearchSessionSummary {
  return {
    session_id: record.session_id,
    status: LOCAL_SESSION_STATUS,
    stimulus_versions: record.stimulus_versions,
    uploaded_runs: [],
    has_questionnaire: false,
    patient_info: {
      name: record.payload.patient_info.name,
      dob: record.payload.patient_info.dob,
    },
    ground_truth: null,
    assessment_names: [],
    created_at: new Date(record.createdAt).toISOString(),
  };
}

function pendingToDetail(record: PendingSessionRecord): ResearchSessionDetail {
  return {
    ...pendingToSummary(record),
    patient_info: record.payload.patient_info,
    metadata: record.payload.metadata,
    data_usage_consent: record.payload.data_usage_consent,
  };
}

/**
 * Sessions list with offline support: network results are cached per-uid in
 * IndexedDB; on network failure the last successful response is served instead.
 * Sessions created on this device but not yet synced are merged in on top
 * (status LOCAL) so a fully-offline researcher still sees today's work.
 */
export async function getResearchSessionsOfflineAware(): Promise<ResearchSessionSummary[]> {
  const uid = getUidFromToken(useAuthStore.getState().token, true);
  const cacheKey = uid ? (`sessions_list:${uid}` as const) : null;

  let serverSessions: ResearchSessionSummary[];
  try {
    // First page only — this feeds the dashboard's recents card; the full
    // history lives on the paginated All Sessions page (online-only).
    serverSessions = (await getResearchSessions()).items;
    if (cacheKey) {
      await putMetadataCacheEntry(cacheKey, serverSessions);
    }
  } catch (err) {
    if (!isNetworkFailure(err) || !cacheKey) throw err;
    const entry = await getMetadataCacheEntry<ResearchSessionSummary[]>(cacheKey);
    if (!entry) throw err;
    serverSessions = entry.value;
  }

  const localRuns = await localPendingRunsBySession();
  const withLocalRuns = serverSessions.map(s => ({
    ...s,
    uploaded_runs: mergeLocalRuns(s.uploaded_runs, localRuns.get(s.session_id)),
  }));

  if (!uid) return withLocalRuns;

  // Local-only sessions first — newest work, and the ones a researcher offline
  // in the field most needs to see.
  const localOnly = (await listUncreatedSessionsForUid(uid))
    .filter(p => !withLocalRuns.some(s => s.session_id === p.session_id))
    .map(p => {
      const summary = pendingToSummary(p);
      return {
        ...summary,
        uploaded_runs: mergeLocalRuns(summary.uploaded_runs, localRuns.get(p.session_id)),
      };
    })
    .reverse();

  return [...localOnly, ...withLocalRuns];
}

/**
 * Session detail with offline support. A session that only exists on this
 * device is rebuilt from its queued create payload; otherwise network with a
 * fallback to the cached copy of the last successful fetch.
 */
export async function getResearchSessionOfflineAware(
  sessionId: string
): Promise<ResearchSessionDetail> {
  const pending = await getPendingSession(sessionId);
  if (pending && pending.syncStatus !== 'created') {
    const detail = pendingToDetail(pending);
    const localRuns = await localPendingRunsBySession();
    return {
      ...detail,
      uploaded_runs: mergeLocalRuns(detail.uploaded_runs, localRuns.get(sessionId)),
    };
  }

  const cacheKey = `session_detail:${sessionId}` as const;
  let detail: ResearchSessionDetail;
  try {
    detail = await getResearchSession(sessionId);
    await putMetadataCacheEntry(cacheKey, detail);
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const entry = await getMetadataCacheEntry<ResearchSessionDetail>(cacheKey);
    if (entry) {
      detail = entry.value;
    } else if (pending) {
      // Created on this device (already synced) but detail never fetched — the
      // local payload is still an accurate rebuild for resuming.
      detail = pendingToDetail(pending);
    } else {
      throw err;
    }
  }

  const localRuns = await localPendingRunsBySession();
  return {
    ...detail,
    uploaded_runs: mergeLocalRuns(detail.uploaded_runs, localRuns.get(sessionId)),
  };
}
