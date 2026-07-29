import { z } from 'zod';

/**
 * Validation for one normalized camp-roster row (Excel cells are normalized to
 * strings by lib/camps/roster.ts before reaching this schema).
 *
 * Name/notes constraints mirror the middleware's validate_safe_text so a row
 * that imports cleanly can never 422 later when the session is created: no
 * <>, and only the characters its allowlist accepts.
 */

const SAFE_TEXT_PATTERN = /^[A-Za-z0-9\s\-,'()&]+$/;

export const campRosterRowSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be at most 100 characters')
    .refine(value => SAFE_TEXT_PATTERN.test(value), {
      message: "Name may only contain letters, numbers, spaces and - , ' ( ) &",
    }),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'DOB must be a valid date (YYYY-MM-DD)')
    .refine(value => {
      const date = new Date(`${value}T00:00:00`);
      if (Number.isNaN(date.getTime())) return false;
      const year = date.getFullYear();
      return year >= 1900 && date.getTime() <= Date.now();
    }, 'DOB must be a real date between 1900 and today'),
  gender: z.enum(['male', 'female', 'other'], {
    message: 'Gender must be male, female or other',
  }),
  guardianPhone: z
    .string()
    .trim()
    .refine(value => value === '' || /^\+?\d{7,15}$/.test(value.replace(/[\s-]/g, '')), {
      message: 'Guardian phone must be 7-15 digits',
    })
    .transform(value => value.replace(/[\s-]/g, '')),
  groundTruthRaw: z.string().trim().max(2000, 'Ground truth text is too long'),
  notes: z
    .string()
    .trim()
    .max(2000, 'Notes must be at most 2000 characters')
    .refine(value => !/[<>]/.test(value), 'Notes must not contain < or >'),
});

export type CampRosterRow = z.infer<typeof campRosterRowSchema>;
