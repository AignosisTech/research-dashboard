import { CloudOff, Loader2, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { processSyncQueue } from '@/lib/offline/syncManager';
import { useSyncStatus } from '@/lib/offline/useSyncStatus';

/**
 * Header badge summarising everything captured on this device that still owes
 * the server something: session creates, run uploads, questionnaires,
 * assessments, and camp-roster ground truths. Click = force a sync pass.
 */
export const PendingSyncBadge = () => {
  const status = useSyncStatus();
  const count =
    status.pendingSessionCount +
    status.pendingUploadCount +
    status.pendingQuestionnaireCount +
    status.pendingAssessmentCount +
    status.pendingGroundTruthCount;

  if (count === 0 && !status.pausedForAuth) return null;

  const label = status.pausedForAuth
    ? 'Sign in to sync'
    : status.isSyncing
      ? `Syncing ${count}…`
      : status.failedCount > 0
        ? `${status.failedCount} failed`
        : `${count} pending`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 h-8 px-2"
            onClick={() => void processSyncQueue({ force: true })}
            disabled={status.pausedForAuth}
          >
            {status.isSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <CloudOff className="h-4 w-4 text-amber-500" />
            )}
            <Badge variant="secondary" className="font-normal">
              {label}
            </Badge>
            {!status.pausedForAuth && !status.isSyncing && (
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {status.pausedForAuth
            ? 'Your session expired. Sign in again to upload pending work.'
            : status.lastSyncError ||
              'Work saved on this device waiting to upload. Click to retry sync.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
