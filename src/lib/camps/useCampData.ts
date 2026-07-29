import { useCallback, useEffect, useState } from 'react';

import { getCamp, listCampsForUid } from '@/lib/offline/db';
import { getUidFromToken } from '@/lib/offline/jwt';
import { subscribeSyncStatus } from '@/lib/offline/syncManager';
import type { CampRecord } from '@/lib/offline/types';
import { useAuthStore } from '@/stores/authStore';

import { type CampChildWithStatus, listCampChildrenWithStatus } from './status';

/** uid for scoping local camp records; expired tokens still count locally. */
export function useCampUid(): string | null {
  const token = useAuthStore(s => s.token);
  return getUidFromToken(token, true);
}

export function useCamps(): {
  camps: CampRecord[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const uid = useCampUid();
  const [camps, setCamps] = useState<CampRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const rows = uid ? await listCampsForUid(uid) : await Promise.resolve([]);
    setCamps(rows);
    setIsLoading(false);
  }, [uid]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const rows = uid ? await listCampsForUid(uid) : await Promise.resolve([]);
      if (cancelled) return;
      setCamps(rows);
      setIsLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [uid]);

  return { camps, isLoading, refresh };
}

/**
 * The camp and its roster with live-derived sync statuses: re-derives whenever
 * the sync engine emits, so badges flip pending → synced as the queue drains.
 */
export function useCampDetail(campId: string | undefined): {
  camp: CampRecord | null;
  children: CampChildWithStatus[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [camp, setCamp] = useState<CampRecord | null>(null);
  const [children, setChildren] = useState<CampChildWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!campId) {
      await Promise.resolve();
      setIsLoading(false);
      return;
    }
    const [campRecord, rows] = await Promise.all([
      getCamp(campId),
      listCampChildrenWithStatus(campId),
    ]);
    setCamp(campRecord ?? null);
    setChildren(rows);
    setIsLoading(false);
  }, [campId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!campId) {
        await Promise.resolve();
        if (!cancelled) setIsLoading(false);
        return;
      }
      const [campRecord, rows] = await Promise.all([
        getCamp(campId),
        listCampChildrenWithStatus(campId),
      ]);
      if (cancelled) return;
      setCamp(campRecord ?? null);
      setChildren(rows);
      setIsLoading(false);
    };
    void load();

    // Sync progress changes derived statuses — refresh on every emission after
    // the initial one (the subscribe callback fires immediately with current
    // state, which the load above already covers).
    let first = true;
    const unsubscribe = subscribeSyncStatus(() => {
      if (first) {
        first = false;
        return;
      }
      if (!cancelled) void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [campId]);

  return { camp, children, isLoading, refresh };
}
