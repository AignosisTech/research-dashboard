import type { StimulusVersion } from '@/lib/api/research';

/** Same options the intake form offers — collected once per camp instead. */
export const CAMP_SCREEN_SIZES = [12.4, 13, 14, 15.6, 17, 19, 21.5, 24, 27, 32] as const;

export const CAMP_LANGUAGES = ['english', 'hindi'] as const;

export const CAMP_STIMULUS_VERSION_OPTIONS: {
  value: StimulusVersion;
  label: string;
  hint: string;
}[] = [
  { value: '1', label: 'Video 1', hint: 'AST stimulus - V1' },
  { value: '2', label: 'Video 2', hint: 'AST stimulus - V2' },
];
