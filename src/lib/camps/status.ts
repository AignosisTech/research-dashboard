import { db, getUncreatedSessionIds, listCampChildren } from '@/lib/offline/db';
import type { CampChildRecord } from '@/lib/offline/types';
import { listPendingUploads } from '@/lib/uploads/pendingUploads';

/**
 * Roster row status as shown in the camp table. Only 'pending' | 'recorded' is
 * stored on the row; whether a recording has fully synced is derived from the
 * offline queues at render time so the table can never disagree with the sync
 * engine.
 */
export type DerivedCampChildStatus = 'pending' | 'recorded' | 'synced' | 'sync_failed';

export interface CampChildWithStatus extends CampChildRecord {
  derivedStatus: DerivedCampChildStatus;
}

export async function listCampChildrenWithStatus(campId: string): Promise<CampChildWithStatus[]> {
  const children = await listCampChildren(campId);

  const [uncreatedSessions, pendingUploads, pendingQuestionnaires, pendingGroundTruths] =
    await Promise.all([
      getUncreatedSessionIds(),
      listPendingUploads(),
      db.pendingQuestionnaires.toArray(),
      db.pendingGroundTruths.toArray(),
    ]);

  const uploadSessions = new Set(pendingUploads.map(u => u.session_id));
  const questionnaireSessions = new Set(pendingQuestionnaires.map(q => q.session_id));
  const groundTruthSessions = new Set(pendingGroundTruths.map(g => g.session_id));
  const failedSessions = new Set([
    ...pendingQuestionnaires.filter(q => q.syncStatus === 'failed').map(q => q.session_id),
    ...pendingGroundTruths.filter(g => g.syncStatus === 'failed').map(g => g.session_id),
  ]);
  const failedCreates = new Set(
    (await db.pendingSessions.where('syncStatus').equals('failed').toArray()).map(s => s.session_id)
  );

  return children.map(child => {
    let derivedStatus: DerivedCampChildStatus = child.status;
    if (child.status === 'recorded' && child.sessionId) {
      const sid = child.sessionId;
      const stillOwed =
        uncreatedSessions.has(sid) ||
        uploadSessions.has(sid) ||
        questionnaireSessions.has(sid) ||
        groundTruthSessions.has(sid);
      if (failedSessions.has(sid) || failedCreates.has(sid)) derivedStatus = 'sync_failed';
      else if (!stillOwed) derivedStatus = 'synced';
    }
    return { ...child, derivedStatus };
  });
}
