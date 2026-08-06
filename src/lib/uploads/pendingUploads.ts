import { isAxiosError } from 'axios';

import { type UploadProgressPayload, uploadResearchTestData } from '@/lib/api/research';
import { db, getUncreatedSessionIds } from '@/lib/offline/db';

/**
 * Local-first safety net for research uploads (NOT the clinic offline subsystem).
 *
 * Every encrypted upload payload is persisted to IndexedDB before the network
 * request starts and deleted only after the server confirms it. If the tab
 * closes, the machine sleeps, or the upload fails, the recording survives on
 * this device and is re-uploaded in the background from the dashboard. Retries
 * are safe because the server derives a deterministic test id from
 * (session_id, video_index).
 *
 * Nothing is ever auto-discarded. A recording is irreplaceable — a child sat
 * through a five-minute stimulus to produce it — so even a "permanent" server
 * rejection (which, since the payload is client-generated, would signal a bug
 * on our side) keeps the row and surfaces it for a human to decide. Storage is
 * bounded by the researcher explicitly discarding from the dashboard.
 *
 * Privacy: only AES-GCM-encrypted blobs are stored — never plaintext video.
 * The child's name is kept so the indicator can say which recording is stuck.
 *
 * Blobs live in a separate table from metadata so listing/counting pending
 * uploads never pulls ~65 MB per row into memory.
 */

// The Dexie instance (and the v1/v2 schema history for these two tables) lives
// in src/lib/offline/db.ts so the offline subsystem's tables share one database
// declaration. The record types are re-exported here so existing imports keep
// working.
export type { PendingUploadBlobs, PendingUploadMeta } from '@/lib/offline/db';
import type { PendingUploadBlobs, PendingUploadMeta } from '@/lib/offline/db';

export const pendingUploadId = (sessionId: string, videoIndex: number) =>
  `${sessionId}:${videoIndex}`;

// --- reactivity -------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

export const subscribeToPendingUploads = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = () => {
  listeners.forEach(listener => listener());
};

export interface FlushState {
  isFlushing: boolean;
  /** Id of the row currently uploading, if any. */
  activeId: string | null;
  activeProgress: UploadProgressPayload | null;
  /**
   * Bumped only when the queue itself changes — a row added, removed, or its
   * status updated. Never bumped on an upload-progress tick, so subscribers can
   * tell a real queue change from a byte counter moving.
   */
  queueVersion: number;
}

let flushState: FlushState = {
  isFlushing: false,
  activeId: null,
  activeProgress: null,
  queueVersion: 0,
};

export const getFlushState = (): FlushState => flushState;

const setFlushState = (next: Partial<FlushState>) => {
  flushState = { ...flushState, ...next };
  notify();
};

const notifyQueueChanged = () => {
  setFlushState({ queueVersion: flushState.queueVersion + 1 });
};

// --- persistence ------------------------------------------------------------

export const savePendingUpload = async (
  meta: PendingUploadMeta,
  blobs: PendingUploadBlobs
): Promise<void> => {
  await db.transaction('rw', db.pendingUploads, db.pendingUploadBlobs, async () => {
    await db.pendingUploads.put(meta);
    await db.pendingUploadBlobs.put(blobs);
  });
  notifyQueueChanged();
};

export const deletePendingUpload = async (id: string): Promise<void> => {
  await db.transaction('rw', db.pendingUploads, db.pendingUploadBlobs, async () => {
    await db.pendingUploads.delete(id);
    await db.pendingUploadBlobs.delete(id);
  });
  notifyQueueChanged();
};

/** List pending uploads, oldest first. Never loads blobs. */
export const listPendingUploads = async (): Promise<PendingUploadMeta[]> =>
  db.pendingUploads.orderBy('created_at').toArray();

export const countPendingUploads = async (): Promise<number> => db.pendingUploads.count();

/** Rebuild the multipart body — the single source of truth for field names. */
export const buildUploadFormData = (
  meta: PendingUploadMeta,
  blobs: PendingUploadBlobs
): FormData => {
  const formData = new FormData();
  formData.append('video_file', blobs.video_file, 'vid.bin');
  formData.append('video_encrypted_aes_key', blobs.video_encrypted_aes_key, 'vid_aes.bin');
  if (blobs.encrypted_calibration_points) {
    formData.append(
      'encrypted_calibration_points',
      blobs.encrypted_calibration_points,
      'frames.bin'
    );
  }
  if (blobs.encrypted_mirror_frame) {
    formData.append('encrypted_mirror_frame', blobs.encrypted_mirror_frame, 'mirror.bin');
  }
  if (meta.encrypted_aes_password) {
    formData.append('encrypted_aes_password', meta.encrypted_aes_password);
  }
  formData.append('session_id', meta.session_id);
  formData.append('video_index', String(meta.video_index));
  formData.append('data_usage_consent', String(meta.data_usage_consent));
  formData.append('metadata', JSON.stringify(meta.metadata));
  return formData;
};

/**
 * Uploads currently in flight in the live test flow. The background flush skips
 * these so it never races an upload the flow already started.
 */
const inFlightIds = new Set<string>();

export const markUploadInFlight = (id: string) => {
  inFlightIds.add(id);
  notifyQueueChanged();
};

export const clearUploadInFlight = (id: string) => {
  inFlightIds.delete(id);
  notifyQueueChanged();
};

export const isUploadInFlight = (id: string) => inFlightIds.has(id);

// --- background flush -------------------------------------------------------

const describeError = (error: unknown): string => {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (!error.response) return 'Network unavailable';
    if (status === 401) return 'Signed out — sign in again to upload';
    if (status === 404) return 'Session no longer exists';
    if (status === 403) return 'Not permitted for this account';
    const message = (error.response.data as { message?: string } | undefined)?.message;
    return message || `Server error (HTTP ${status})`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
};

export interface FlushResult {
  uploaded: number;
  failed: number;
}

/**
 * Re-upload every persisted payload not already in flight, deleting rows the
 * server confirms. Sequential on purpose — recovered uploads should not compete
 * with each other for bandwidth. Failures are recorded on the row (attempts,
 * last_error) and retried on the next flush; nothing is discarded automatically.
 * Returns null if a flush is already running.
 */
export const flushPendingUploads = async (): Promise<FlushResult | null> => {
  if (flushState.isFlushing) return null;
  setFlushState({ isFlushing: true, activeId: null, activeProgress: null });

  const result: FlushResult = { uploaded: 0, failed: 0 };

  try {
    const rows = await listPendingUploads();
    // Sessions created offline must reach the server before their runs can
    // upload (the upload endpoint 404s on a missing session). The sync manager
    // replays session creation first; skip runs whose session is still owed.
    const uncreatedSessions = await getUncreatedSessionIds();

    for (const meta of rows) {
      if (inFlightIds.has(meta.id)) continue;
      if (uncreatedSessions.has(meta.session_id)) continue;

      const blobs = await db.pendingUploadBlobs.get(meta.id);
      if (!blobs) {
        // Metadata without its payload can never upload — drop the orphan.
        await deletePendingUpload(meta.id);
        continue;
      }

      setFlushState({ activeId: meta.id, activeProgress: null });

      try {
        await uploadResearchTestData(buildUploadFormData(meta, blobs), {
          onUploadProgress: progress => setFlushState({ activeProgress: progress }),
        });
        await deletePendingUpload(meta.id);
        result.uploaded += 1;
      } catch (error) {
        const description = describeError(error);
        console.warn(
          `[PendingUploads] Upload ${meta.id} failed (${description}); keeping for retry`
        );
        await db.pendingUploads.update(meta.id, {
          attempts: meta.attempts + 1,
          last_error: description,
          last_attempt_at: Date.now(),
        });
        notifyQueueChanged();
        result.failed += 1;
      }
    }
  } finally {
    setFlushState({ isFlushing: false, activeId: null, activeProgress: null });
  }

  return result;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
