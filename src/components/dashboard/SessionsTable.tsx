import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Check, Minus, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { AssessmentSheet } from '@/components/dashboard/AssessmentSheet';
import { sessionOutcomeLabels } from '@/components/dashboard/sessionLabels';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMutation } from '@/hooks/useMutation';
import {
  deleteResearchSession,
  type ResearchSessionSummary,
  type StimulusVersion,
} from '@/lib/api/research';
import { getResearchSessionOfflineAware, LOCAL_SESSION_STATUS } from '@/lib/offline/sessions';
import { formatDateShort } from '@/lib/utils';
import { useTestStore } from '@/stores/testStore';

interface SessionRun {
  video_index: number;
  version: StimulusVersion;
  uploaded: boolean;
}

/** The session's planned runs, each flagged with whether its recording has landed. */
const sessionRuns = (session: ResearchSessionSummary): SessionRun[] =>
  (session.stimulus_versions ?? []).map((version, index) => ({
    video_index: index + 1,
    version,
    uploaded: session.uploaded_runs.some(run => run.video_index === index + 1),
  }));

/** A session that was created but abandoned before any recording was uploaded. */
const isPendingSession = (session: ResearchSessionSummary) => session.uploaded_runs.length === 0;

interface SessionsTableProps {
  sessions: ResearchSessionSummary[];
  isLoading: boolean;
  /**
   * useMutation-style query key names to invalidate after a delete — each page
   * passes its own list key plus any siblings that render the same rows.
   */
  invalidateQueries: string[];
  emptyState: React.ReactNode;
}

/**
 * The research sessions table with its full row behavior — resume missing
 * runs, delete pending sessions, edit ground truth / assessments — shared by
 * the dashboard's recents card and the paginated All Sessions page.
 */
export const SessionsTable = ({
  sessions,
  isLoading,
  invalidateQueries,
  emptyState,
}: SessionsTableProps) => {
  const navigate = useNavigate();
  const resetTestData = useTestStore(s => s.resetTestData);
  const setTestData = useTestStore(s => s.setTestData);
  const [groundTruthSession, setGroundTruthSession] = useState<ResearchSessionSummary | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<ResearchSessionSummary | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteResearchSession(sessionId),
    showSuccessToast: true,
    successMessage: 'Session deleted',
    invalidateQueries,
    onSettled: () => setSessionToDelete(null),
  });

  /**
   * Rehydrate the test flow from an existing session and re-enter past fill-up,
   * capturing only the runs that are still missing. Full capture metadata is
   * fetched on demand so the dashboard list can stay lean.
   */
  const handleResume = async (session: ResearchSessionSummary, onlyIndex?: number) => {
    setResumingId(session.session_id);
    try {
      const detail = await getResearchSessionOfflineAware(session.session_id);
      const { patient_info: patientInfo, metadata } = detail;

      if (!patientInfo?.name || !patientInfo.dob || !patientInfo.gender || !metadata) {
        toast.error('This session is missing intake data and cannot be resumed');
        return;
      }

      const runs = sessionRuns(detail);
      const queue = runs
        .filter(run => !run.uploaded && (onlyIndex === undefined || run.video_index === onlyIndex))
        .map(run => run.video_index);

      if (queue.length === 0) {
        toast.info('All videos for this session are already recorded');
        return;
      }

      resetTestData();
      setTestData({
        session_id: detail.session_id,
        patient_info: {
          name: patientInfo.name,
          dob: patientInfo.dob,
          gender: patientInfo.gender as 'male' | 'female' | 'other',
          guardian_phone: patientInfo.guardian_phone ?? '',
        },
        metadata,
        data_usage_consent: detail.data_usage_consent ?? true,
        stimulus_versions: detail.stimulus_versions ?? ['2'],
        video_count: detail.stimulus_versions?.length ?? 1,
        run_queue: queue,
        current_video_index: queue[0],
        questionnaire_completed: detail.has_questionnaire,
        uploaded_test_ids: [],
      });
      navigate('/test/instructions');
    } catch (error) {
      console.error('[SessionsTable] Failed to resume session', error);
      toast.error(error instanceof Error ? error.message : 'Could not open this session');
    } finally {
      setResumingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="w-full h-11" />
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-muted/50 bg-muted/80">
              <TableHead>Participant</TableHead>
              <TableHead>Videos recorded</TableHead>
              <TableHead>Questionnaire</TableHead>
              <TableHead>DOB</TableHead>
              <TableHead>Ground Truth</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map(session => {
              const runs = sessionRuns(session);
              const missingRuns = runs.filter(run => !run.uploaded);
              const isResuming = resumingId === session.session_id;
              const isLocalOnly = session.status === LOCAL_SESSION_STATUS;

              return (
                <TableRow key={session.session_id}>
                  <TableCell className="font-medium capitalize">
                    <span className="flex flex-wrap gap-1.5 items-center">
                      {session.patient_info?.name || 'Unknown'}
                      {isLocalOnly && (
                        <Badge
                          variant="outline"
                          className="text-[11px] font-normal normal-case border-amber-500/60 text-amber-600 dark:text-amber-400"
                        >
                          On this device — not yet synced
                        </Badge>
                      )}
                      {session.camp_name && (
                        <Badge variant="outline" className="text-[11px] font-normal normal-case">
                          {session.camp_name}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {runs.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        runs.map(run => (
                          <Badge
                            key={run.video_index}
                            variant={run.uploaded ? 'secondary' : 'outline'}
                            className={
                              run.uploaded ? 'gap-1' : 'gap-1 text-muted-foreground border-dashed'
                            }
                          >
                            {run.uploaded ? (
                              <Check className="size-3" />
                            ) : (
                              <Minus className="size-3" />
                            )}
                            Video {run.version}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {session.has_questionnaire ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="size-3" />
                        Recorded
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Not filled</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateShort(session.patient_info?.dob)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {sessionOutcomeLabels(session).length > 0 ? (
                        sessionOutcomeLabels(session).map(label => (
                          <Badge key={label} variant="secondary">
                            {label}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {(session.assessment_names?.length ?? 0) > 0 && (
                        <Badge variant="outline" className="font-normal">
                          +{session.assessment_names?.length} assessment
                          {session.assessment_names?.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {!isLocalOnly && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Edit ground truth and assessments"
                          onClick={() => setGroundTruthSession(session)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 items-center">
                      {missingRuns.length > 0 &&
                        missingRuns.map(run => (
                          <Button
                            key={run.video_index}
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 px-2 h-7"
                            disabled={isResuming}
                            onClick={() => void handleResume(session, run.video_index)}
                          >
                            <RotateCcw className="size-3.5" />
                            Record video {run.version}
                          </Button>
                        ))}

                      {isPendingSession(session) && !isLocalOnly && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-destructive hover:text-destructive"
                          aria-label="Delete session"
                          disabled={isResuming}
                          onClick={() => setSessionToDelete(session)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}

                      {missingRuns.length === 0 && !isPendingSession(session) && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog
        open={!!sessionToDelete}
        onOpenChange={open => {
          if (!open) setSessionToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this pending session?</AlertDialogTitle>
            <AlertDialogDescription>
              The session
              {sessionToDelete?.patient_info?.name ? (
                <>
                  {' '}
                  for <span className="capitalize">{sessionToDelete.patient_info.name}</span>
                </>
              ) : null}{' '}
              has no uploaded recordings and will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (sessionToDelete) deleteMutation.mutate(sessionToDelete.session_id);
              }}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {groundTruthSession && (
        <AssessmentSheet
          key={groundTruthSession.session_id}
          session={groundTruthSession}
          open={!!groundTruthSession}
          onOpenChange={open => {
            if (!open) setGroundTruthSession(null);
          }}
        />
      )}
    </>
  );
};
