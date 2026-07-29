import { useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';

import { AIIMSForm, type AIIMSFormData } from '@/components/assessments/AIIMSForm';
import { CARS2Form, type CARS2FormData } from '@/components/assessments/CARS2Form';
import { ClinicalEvaluationPanel } from '@/components/assessments/ClinicalEvaluationPanel';
import { DSTAssessmentPanel, type DSTFormData } from '@/components/assessments/DSTAssessmentPanel';
import { ISAAForm, type ISAAFormData } from '@/components/assessments/ISAAForm';
import { MCHATRForm, type MCHATRFormData } from '@/components/assessments/MCHATRForm';
import { VanderbiltForm, type VanderbiltFormData } from '@/components/assessments/VanderbiltForm';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { useQuery } from '@/hooks/useQuery';
import { type ResearchSessionSummary } from '@/lib/api/research';
import {
  RESEARCH_ASSESSMENT_OPTIONS,
  type ResearchAssessmentId,
  STORED_ASSESSMENT_IDS,
  type StoredAssessmentId,
} from '@/lib/assessments/registry';
import { getSessionAssessmentOfflineAware, isUnsyncedAssessment } from '@/lib/offline/assessments';
import { cn, formatDateShort } from '@/lib/utils';

interface AssessmentSheetProps {
  session: ResearchSessionSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The research equivalent of the internal dashboard's test workspace: one sheet
 * holding the ground-truth labels plus every clinical instrument.
 *
 * Each instrument is fetched only when its tab is first opened — the bodies are
 * large (DST alone is 88 items) and most sessions have none of them filled in.
 */
export const AssessmentSheet = ({ session, open, onOpenChange }: AssessmentSheetProps) => {
  const [activeTab, setActiveTab] = useState<ResearchAssessmentId>('evaluation');
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();

  const sessionId = session.session_id;
  const savedNames = new Set<string>(session.assessment_names ?? []);
  const savedCount = savedNames.size;
  const participantName = session.patient_info?.name;

  const isStored = (tab: ResearchAssessmentId): tab is StoredAssessmentId => tab !== 'evaluation';

  const assessmentQuery = useQuery({
    queryKey: ['researchAssessment', sessionId, activeTab],
    queryFn: () => getSessionAssessmentOfflineAware(sessionId, activeTab as StoredAssessmentId),
    enabled: open && isStored(activeTab),
    staleTime: 0,
  });

  // After a save the row's assessment_names and the cached body are both stale.
  const handleSaved = () => {
    void queryClient.invalidateQueries({ queryKey: ['researchAssessment', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['researchSessions'] });
    void queryClient.invalidateQueries({ queryKey: ['allResearchSessions'] });
  };

  const sessionPatient = session.patient_info ?? null;
  const existing = assessmentQuery.data ?? null;
  const isLoadingAssessment = isStored(activeTab) && assessmentQuery.isLoading;

  const formProps = {
    sessionId,
    readOnly: false,
    onSave: handleSaved,
    sessionPatient,
  };

  // The forms seed their state at mount rather than syncing via an effect, so
  // they must remount when the fetched record arrives (or is saved for the
  // first time) — otherwise the form would keep its pre-load blank state.
  // Passed directly rather than via formProps: React ignores a `key` that
  // arrives through a spread.
  const formKey = `${sessionId}-${activeTab}-${existing ? 'saved' : 'new'}`;

  const showUnsyncedBadge = isStored(activeTab) && isUnsyncedAssessment(existing);

  const renderAssessment = () => {
    if (isLoadingAssessment) {
      return (
        <div className="flex flex-1 justify-center items-center p-8 text-sm text-muted-foreground">
          Loading assessment…
        </div>
      );
    }

    // One query serves every tab, so its result is the loose StoredAssessment
    // shape; each branch narrows it to that instrument's own form type. The
    // server is the authority on the shape — it validated the record on write.
    const as = <T,>() => existing as T | null;

    switch (activeTab) {
      case 'isaa':
        return <ISAAForm key={formKey} {...formProps} existingData={as<ISAAFormData>()} />;
      case 'mchat_r':
        return <MCHATRForm key={formKey} {...formProps} existingData={as<MCHATRFormData>()} />;
      case 'cars2':
        return <CARS2Form key={formKey} {...formProps} existingData={as<CARS2FormData>()} />;
      case 'aiims':
        return <AIIMSForm key={formKey} {...formProps} existingData={as<AIIMSFormData>()} />;
      case 'vanderbilt':
        return (
          <VanderbiltForm key={formKey} {...formProps} existingData={as<VanderbiltFormData>()} />
        );
      case 'dst':
        return <DSTAssessmentPanel key={formKey} {...formProps} existingData={as<DSTFormData>()} />;
      default:
        return null;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'flex w-full max-w-full flex-col gap-0 overflow-hidden p-0',
          'max-md:w-full max-md:max-w-full max-md:border-0',
          // One width for every tab: the instrument forms need the room for
          // their item rows, and re-laying out on each tab switch is jarring.
          'sm:max-w-2xl md:max-w-3xl lg:max-w-[min(96vw,80rem)]'
        )}
      >
        <SheetHeader className="gap-1.5 px-4 py-4 border-b shrink-0 border-border/80 pr-12 text-left sm:px-6">
          <div className="flex flex-wrap gap-2 items-center">
            <SheetTitle className="text-base capitalize sm:text-lg">
              {participantName || 'Session'}
            </SheetTitle>
            {session.status && (
              <Badge variant="outline" className="text-[11px] font-normal">
                {session.status}
              </Badge>
            )}
            {savedCount > 0 && (
              <Badge variant="secondary" className="text-[11px] font-normal">
                {savedCount} of {STORED_ASSESSMENT_IDS.length} filled
              </Badge>
            )}
            {showUnsyncedBadge && (
              <Badge
                variant="outline"
                className="text-[11px] font-normal border-amber-500/60 text-amber-600 dark:text-amber-400"
              >
                Saved on device — scores pending sync
              </Badge>
            )}
          </div>
          <SheetDescription className="flex flex-wrap gap-x-2 gap-y-0.5 items-center text-xs">
            {session.patient_info?.dob && (
              <>
                <span>DOB {formatDateShort(session.patient_info.dob)}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="font-mono">{sessionId}</span>
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={v => setActiveTab(v as ResearchAssessmentId)}
          className="flex flex-col flex-1 gap-0 min-h-0"
        >
          <div className="px-4 py-2.5 border-b shrink-0 border-border/80 sm:px-6">
            {isMobile ? (
              <Select
                value={activeTab}
                onValueChange={v => setActiveTab(v as ResearchAssessmentId)}
              >
                <SelectTrigger className="w-full h-10 bg-background">
                  <SelectValue placeholder="Select assessment" />
                </SelectTrigger>
                <SelectContent>
                  {RESEARCH_ASSESSMENT_OPTIONS.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      <span className="flex gap-2 items-center">
                        {option.label}
                        {savedNames.has(option.id) && (
                          <Check className="size-3.5 text-primary" aria-label="Filled in" />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              // Always a scrolling strip — seven equal grid columns squeezes the
              // longer labels until they are unreadable.
              <div className="overflow-x-auto -mb-1 pb-1">
                <TabsList className="inline-flex gap-1 justify-start p-1 h-9 w-max bg-muted/40">
                  {RESEARCH_ASSESSMENT_OPTIONS.map(option => (
                    <TabsTrigger
                      key={option.id}
                      value={option.id}
                      title={option.description}
                      className="gap-1.5 px-3 text-xs shrink-0 whitespace-nowrap sm:text-sm"
                    >
                      {option.label}
                      {savedNames.has(option.id) && (
                        <Check className="size-3.5 text-primary" aria-label="Filled in" />
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            )}
          </div>

          <TabsContent
            value="evaluation"
            className="flex flex-col flex-1 mt-0 min-h-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <ClinicalEvaluationPanel
              sessionId={sessionId}
              initial={session.ground_truth}
              onSaved={handleSaved}
            />
          </TabsContent>

          {RESEARCH_ASSESSMENT_OPTIONS.filter(option => option.id !== 'evaluation').map(option => (
            <TabsContent
              key={option.id}
              value={option.id}
              className="flex flex-col flex-1 mt-0 min-h-0 overflow-hidden data-[state=inactive]:hidden"
            >
              {activeTab === option.id && renderAssessment()}
            </TabsContent>
          ))}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
};
