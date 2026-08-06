import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { ClinicAddress, ClinicInfo } from '@/lib/api/types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Formats a date string into a human-readable format with time.
 *
 * @param dateString - The date string to format. Can be any valid date string,
 *                     null, or undefined.
 * @returns A formatted date string in the format "Mon DD, YYYY, HH:MM AM/PM"
 *          (e.g., "Dec 9, 2024, 04:30 PM"). Returns 'N/A' if the input is
 *          null/undefined, or the original string if parsing fails.
 *
 * @example
 * formatDate('2024-12-09T16:30:00Z') // "Dec 9, 2024, 04:30 PM"
 * formatDate(null) // "N/A"
 */
export const formatDate = (dateString: string | null | undefined) => {
  if (!dateString) return 'N/A';
  try {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateString;
  }
};

/**
 * Formats a date string into a short human-readable format (date only, no time).
 *
 * @param dateString - The date string to format. Can be any valid date string,
 *                     null, or undefined.
 * @returns A formatted date string in the format "Mon DD, YYYY"
 *          (e.g., "Dec 9, 2024"). Returns 'N/A' if the input is
 *          null/undefined, or the original string if parsing fails.
 *
 * @example
 * formatDateShort('2024-12-09T16:30:00Z') // "Dec 9, 2024"
 * formatDateShort(null) // "N/A"
 */
export const formatDateShort = (dateString: string | null | undefined) => {
  if (!dateString) return 'N/A';
  try {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateString;
  }
};

export const formatAddress = (address: ClinicInfo['address']): string => {
  if (!address) {
    return 'Address not available';
  }
  const addr = address as ClinicAddress;
  const parts: string[] = [];

  if (addr.street) parts.push(addr.street);
  if (addr.city) parts.push(addr.city);
  if (addr.state) parts.push(addr.state);
  if (addr.postal_code) parts.push(addr.postal_code);
  if (addr.country) parts.push(addr.country);

  return parts.length > 0 ? parts.join(', ') : 'Address not available';
};

/** One-line summary for dashboard chrome when clinic uses MR registration vs street address. */
export const formatClinicLocationSummary = (
  info: Pick<ClinicInfo, 'address' | 'mr_details'>
): string => {
  if (info.mr_details) {
    const d = info.mr_details;
    const hq = d.headquarters || d.pool || '';
    const head = d.state_head ? ` · SH: ${d.state_head}` : '';
    const tlm = d.top_line_manager ? ` · TLM: ${d.top_line_manager}` : '';
    return `${d.employee_name} (${d.employee_id}) — ${d.state}, ${hq}${head}${tlm}`;
  }
  return formatAddress(info.address);
};

/** True when pipeline status indicates failure (substring match on raw status). */
export const isFailedStatus = (status: string) => {
  const statusLower = status?.toLowerCase() || '';
  return statusLower.includes('failed') || statusLower.includes('error');
};

/** Short / incomplete recording vs stimulus (client-side); distinct from PROCESSING_FAILED. */
export const isIncompleteVideoStatus = (status: string) => {
  const u = status?.toUpperCase() || '';
  return u === 'INCOMPLETE_VIDEO';
};

/** Show inline error banner + row emphasis (failed server-side or incomplete client recording). */
export const showsAssessmentErrorBanner = (status: string) =>
  isFailedStatus(status) || isIncompleteVideoStatus(status);

export type AssessmentProblemKind = 'failed' | 'incomplete';

/** Row highlight for dashboard tables: failed = red, incomplete = amber. */
export function getAssessmentProblemKind(status: string): AssessmentProblemKind | null {
  if (isIncompleteVideoStatus(status)) return 'incomplete';
  if (isFailedStatus(status)) return 'failed';
  return null;
}

export const getProcessingStep = (status: string) => {
  const statusUpper = status?.toUpperCase() || '';
  const steps = [
    'CREATED',
    'UPLOADED',
    'QUEUED',
    'PROCESSING_GAZE',
    'PROCESSING_COMPLETED',
    'AI_PROCESSING',
    'AI_COMPLETED',
  ];

  const index = steps.indexOf(statusUpper);
  if (index !== -1) {
    return { current: index + 1, total: 7 };
  }
  return undefined;
};

/**
 * Formats a number as Indian Rupees currency.
 *
 * @param amount - The amount to format
 * @returns A formatted currency string (e.g., "₹21,000")
 *
 * @example
 * formatCurrency(21000) // "₹21,000"
 */
export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

/**
 * Formats a billing period string (YYYY-MM) to readable format.
 *
 * @param month - The billing month in YYYY-MM format
 * @returns A formatted string like "January 2026"
 *
 * @example
 * formatBillingPeriod('2026-01') // "January 2026"
 */
export const formatBillingPeriod = (month: string): string => {
  if (!month || !month.includes('-')) return month;
  try {
    const [year, monthNum] = month.split('-');
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return `${months[parseInt(monthNum) - 1]} ${year}`;
  } catch {
    return month;
  }
};

/**
 * Formats a duration in seconds as m:ss.
 *
 * @param seconds - Duration in seconds (fractions are rounded)
 * @returns A formatted duration string (e.g., "4:19")
 *
 * @example
 * formatDuration(258.5) // "4:19"
 */
export const formatDuration = (seconds: number): string => {
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

/**
 * Formats a date string in Indian locale (DD Mon YYYY).
 *
 * @param dateStr - The date string to format
 * @returns A formatted date string (e.g., "20 Jan 2026") or "—" if invalid
 *
 * @example
 * formatDateIndian('2026-01-20T09:38:34Z') // "20 Jan 2026"
 */
export const formatDateIndian = (dateStr: string | null): string => {
  if (!dateStr) return '—';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};
