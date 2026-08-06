import { useCallback, useEffect, useState } from 'react';

import {
  flushPendingUploads,
  type FlushState,
  getFlushState,
  listPendingUploads,
  type PendingUploadMeta,
  subscribeToPendingUploads,
} from '@/lib/uploads/pendingUploads';

/** Periodic retry while the dashboard is open, so stuck uploads recover unattended. */
const RETRY_INTERVAL_MS = 60_000;

interface UsePendingUploadsResult extends FlushState {
  rows: PendingUploadMeta[];
  /** Trigger a flush now (no-op if one is already running). */
  flushNow: () => void;
}

/**
 * Subscribes to the pending-upload queue and keeps flushing it in the
 * background: on mount, when the network comes back, when the tab regains
 * focus, and on a slow interval. Only summaries are held in state — never the
 * encrypted video blobs.
 */
export const usePendingUploads = (): UsePendingUploadsResult => {
  const [rows, setRows] = useState<PendingUploadMeta[]>([]);
  const [flushState, setFlushState] = useState<FlushState>(getFlushState());

  useEffect(() => {
    let cancelled = false;

    const refreshRows = async () => {
      const next = await listPendingUploads().catch(() => []);
      if (cancelled) return;
      setRows(next);
    };

    void refreshRows();
    void (async () => {
      if (!cancelled) setFlushState(getFlushState());
    })();

    let lastRowSignature = '';
    const unsubscribe = subscribeToPendingUploads(() => {
      const next = getFlushState();
      // Progress ticks fire many times per second; only re-read the table when
      // the queue itself changed, not when a byte counter moved.
      setFlushState(next);
      const signature = `${next.queueVersion}:${next.isFlushing}:${next.activeId}`;
      if (signature !== lastRowSignature) {
        lastRowSignature = signature;
        void refreshRows();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const flushNow = useCallback(() => {
    void flushPendingUploads();
  }, []);

  useEffect(() => {
    // Kick off immediately, then retry on the events that typically unblock an
    // upload (connectivity restored, user returns to the tab) plus a slow timer.
    void flushPendingUploads();

    const onOnline = () => void flushPendingUploads();
    const onFocus = () => void flushPendingUploads();
    const interval = setInterval(() => void flushPendingUploads(), RETRY_INTERVAL_MS);

    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, []);

  return { rows, ...flushState, flushNow };
};
