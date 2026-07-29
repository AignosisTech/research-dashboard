import type { GroundTruth } from '@/lib/api/research';
import { PSYCH_EVAL_OUTCOME_LABELS, type PsychEvalOutcome } from '@/lib/assessments/outcomes';
import { groundTruthSchema } from '@/lib/validations/groundTruth';

/**
 * Roster "Ground Truth" column → outcome codes.
 *
 * Camp rosters are written by field coordinators, not by us, so matching is
 * deliberately forgiving: case/whitespace-insensitive, several aliases per
 * code, multiple labels per cell split on ; or ,. Anything we can't map is a
 * warning, never an import error — the raw text is preserved in the ground
 * truth's notes so no clinical information is dropped.
 */

const LABEL_ALIASES: Record<string, PsychEvalOutcome> = {
  'no concerns': 'no_concerns',
  'no concern': 'no_concerns',
  normal: 'no_concerns',
  typical: 'no_concerns',
  asd: 'asd_positive_direct',
  autism: 'asd_positive_direct',
  autistic: 'asd_positive_direct',
  'asd positive': 'asd_positive_direct',
  'asd (direct)': 'asd_positive_direct',
  'asd direct': 'asd_positive_direct',
  'asd (broad)': 'asd_positive_broad',
  'asd broad': 'asd_positive_broad',
  'developmental delay': 'asd_positive_broad',
  adhd: 'adhd_standard',
  'adhd (standard)': 'adhd_standard',
  'adhd (mild)': 'adhd_mild',
  'adhd mild': 'adhd_mild',
  sld: 'sld',
  'learning difficulty': 'sld',
  'specific learning difficulty': 'sld',
  odd: 'odd_conduct',
  conduct: 'odd_conduct',
  'odd / conduct': 'odd_conduct',
  id: 'intellectual_disability',
  'intellectual disability': 'intellectual_disability',
  gdd: 'global_dev_delay',
  'global developmental delay': 'global_dev_delay',
  epilepsy: 'epilepsy',
  seizure: 'epilepsy',
};

// The raw codes and display labels are always accepted too.
const CODE_LOOKUP: Record<string, PsychEvalOutcome> = { ...LABEL_ALIASES };
for (const [code, label] of Object.entries(PSYCH_EVAL_OUTCOME_LABELS)) {
  if (code === 'custom') continue; // custom requires a paragraph; not roster-expressible
  CODE_LOOKUP[code.toLowerCase()] = code as PsychEvalOutcome;
  CODE_LOOKUP[label.toLowerCase()] = code as PsychEvalOutcome;
}

/** Every label the template's "Allowed values" sheet should advertise. */
export const ROSTER_GROUND_TRUTH_LABELS = [
  'No Concerns',
  'ASD',
  'ASD (Broad)',
  'ADHD',
  'ADHD (Mild)',
  'SLD',
  'ODD / Conduct',
  'Intellectual Disability',
  'Global Developmental Delay',
  'Epilepsy',
] as const;

export interface RosterGroundTruthResult {
  groundTruth: GroundTruth | null;
  /** Set when the cell (or part of it) could not be mapped to outcome codes. */
  warning: string | null;
}

/** Sanitize free text destined for the server's validate_safe_text'd notes field. */
function toSafeNotes(raw: string): string {
  return `Roster ground truth: ${raw.replace(/[<>]/g, '')}`.slice(0, 2000);
}

export function buildRosterGroundTruth(
  rawCell: string | null | undefined
): RosterGroundTruthResult {
  const raw = (rawCell ?? '').trim();
  if (!raw) return { groundTruth: null, warning: null };

  const parts = raw
    .split(/[;,]/)
    .map(part => part.trim())
    .filter(Boolean);

  const codes: PsychEvalOutcome[] = [];
  const unmapped: string[] = [];
  for (const part of parts) {
    const code = CODE_LOOKUP[part.toLowerCase()];
    if (code && !codes.includes(code)) codes.push(code);
    else if (!code) unmapped.push(part);
  }

  if (unmapped.length > 0 || codes.length === 0) {
    // Partially or fully unrecognized — keep the whole raw text as notes so the
    // labels stay together and nothing is silently reinterpreted.
    return {
      groundTruth: {
        schema_version: 1,
        clinician_diagnosis: null,
        outcome_codes: null,
        custom_result_paragraph: null,
        notes: toSafeNotes(raw),
      },
      warning: `Unrecognized ground truth "${unmapped.join(', ') || raw}" — saved as notes instead of outcome labels`,
    };
  }

  const candidate: GroundTruth = {
    schema_version: 1,
    clinician_diagnosis: null,
    outcome_codes: codes,
    custom_result_paragraph: null,
    notes: null,
  };

  // Clinical selection rules (no_concerns exclusive, conflict pairs) — a cell
  // like "No Concerns; ADHD" is contradictory, so fall back to notes.
  const validation = groundTruthSchema.safeParse(candidate);
  if (!validation.success) {
    const reason = validation.error.issues[0]?.message ?? 'conflicting labels';
    return {
      groundTruth: {
        schema_version: 1,
        clinician_diagnosis: null,
        outcome_codes: null,
        custom_result_paragraph: null,
        notes: toSafeNotes(raw),
      },
      warning: `Ground truth "${raw}" is contradictory (${reason}) — saved as notes instead`,
    };
  }

  return { groundTruth: candidate, warning: null };
}
