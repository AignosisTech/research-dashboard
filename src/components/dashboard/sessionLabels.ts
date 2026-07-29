import type { ResearchSessionSummary } from '@/lib/api/research';
import { getPsychEvalOutcomeLabel } from '@/lib/assessments/outcomes';

/**
 * Badge labels for a session's ground truth. Prefers the multi-select outcome
 * codes and falls back to the superseded single-select field so sessions
 * labelled before the expanded set still show something.
 */
export const sessionOutcomeLabels = (session: ResearchSessionSummary): string[] => {
  const codes = session.ground_truth?.outcome_codes;
  if (codes?.length) return codes.map(getPsychEvalOutcomeLabel);

  const legacy = session.ground_truth?.clinician_diagnosis;
  return legacy ? [getPsychEvalOutcomeLabel(legacy)] : [];
};
