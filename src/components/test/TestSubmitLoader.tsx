import { ArrowRight, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { UploadProgressPayload } from '@/lib/api/screening';
import { autismFacts } from '@/lib/constants/facts';

const FILLUP_PATH = '/test/fillup';

interface TestSubmitLoaderProps {
  factIndex: number;
  phase: 'upload' | 'questionnaire' | 'finishing';
  uploadProgress: UploadProgressPayload | null;
  offline?: boolean;
}

function statusLine(
  phase: TestSubmitLoaderProps['phase'],
  uploadProgress: UploadProgressPayload | null,
  offline: boolean
): string {
  if (phase === 'questionnaire') return 'Saving questionnaire…';
  if (phase === 'finishing') return 'Finishing…';
  // Offline runs are persisted to this device, not uploaded — saying
  // "uploading" here reads as a stuck network call to the operator.
  if (offline) return 'No internet — saving on this device…';
  if (!uploadProgress) return 'Preparing upload…';
  if (uploadProgress.percent !== null) {
    return `Uploading video — ${uploadProgress.percent}%`;
  }
  if (uploadProgress.loadedMb > 0) {
    return `Uploading video — ${uploadProgress.loadedMb.toFixed(1)} MB sent`;
  }
  return 'Uploading video…';
}

export const TestSubmitLoader = ({
  factIndex,
  phase,
  uploadProgress,
  offline = false,
}: TestSubmitLoaderProps) => {
  const handleStartNewTest = () => {
    window.open(`${window.location.origin}${FILLUP_PATH}`, '_blank', 'noopener,noreferrer');
  };

  const pct = uploadProgress?.percent;
  // A frozen percent bar while offline reads as a stalled upload.
  const showBar = phase === 'upload' && !offline && pct !== null && pct !== undefined;

  return (
    <div className="flex absolute inset-0 z-50 flex-col justify-center items-center bg-background">
      <div className="flex flex-[1.5] items-end">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
      <div className="flex flex-col gap-4 justify-center flex-1 items-center px-6 w-full max-w-lg text-3xl font-extralight text-primary">
        <p className="mb-1 text-center">{statusLine(phase, uploadProgress, offline)}</p>
        {showBar && pct !== null ? <Progress value={pct} className="h-2 w-full max-w-md" /> : null}
        <p className="text-lg text-muted-foreground font-normal">Please do not close this tab.</p>
        <Button type="button" variant="outline" onClick={handleStartNewTest} className="gap-2">
          <ArrowRight className="h-4 w-4" />
          Start a new test
        </Button>
      </div>

      <div className="flex flex-[0.8] items-center text-center text-primary max-w-[80%]">
        {autismFacts[factIndex]?.fact || ''}
      </div>
    </div>
  );
};
