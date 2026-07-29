import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { isAxiosError } from 'axios';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { PhoneInput } from '@/components/auth/PhoneInput';
import {
  createResearchSession,
  type ResearchSessionCreatePayload,
  type StimulusVersion,
} from '@/lib/api/research';
import { type CampChildNavState, linkChildToSession } from '@/lib/camps/recordFlow';
import { estimateOfflineStorageUsage, putPendingSession } from '@/lib/offline/db';
import { getUidFromToken } from '@/lib/offline/jwt';
import { canTakeTestOffline } from '@/lib/offline/resourceCache';
import { deriveSessionId } from '@/lib/offline/session';
import type { StimulusLanguage } from '@/lib/offline/stimulus';
import { fillupFormSchema } from '@/lib/validations/fillup';
import { validate } from '@/lib/validations/validate';
import { useAuthStore } from '@/stores/authStore';
import { useTestStore } from '@/stores/testStore';

const SCREEN_SIZES = [12.4, 13, 14, 15.6, 17, 19, 21.5, 24, 27, 32] as const;
const LANGUAGES = ['english', 'hindi'] as const;
const FACE_MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model.bin',
] as const;
const GENDERS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
] as const;

// Play order is fixed: version 1 (original) before version 2 (new) when both are selected.
const STIMULUS_VERSION_OPTIONS: { value: StimulusVersion; label: string; hint: string }[] = [
  { value: '1', label: 'Video 1', hint: 'AST stimulus - V1' },
  { value: '2', label: 'Video 2', hint: 'AST stimulus - V2' },
];

interface PrefillData {
  patientName?: string;
  dateOfBirth?: string;
  patientGender?: string;
  guardianPhone?: string;
}

export const Fillup = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const setTestData = useTestStore(s => s.setTestData);
  const resetTestData = useTestStore(s => s.resetTestData);

  const navState = location.state as {
    prefill?: PrefillData;
    campChild?: CampChildNavState;
  } | null;
  const prefillData = navState?.prefill;
  // Camp Mode: identity fields come from the roster and are rendered locked so
  // the queued roster ground truth can never be attached to a different child.
  const campChild = navState?.campChild;
  const backTarget = campChild ? `/camps/${campChild.campId}` : '/dashboard';

  useEffect(() => {
    resetTestData();
  }, [resetTestData]);

  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    void Promise.all(
      FACE_MODEL_FILES.map(async file => {
        const response = await fetch(`${base}models/${file}`, { cache: 'force-cache' });
        if (!response.ok) {
          throw new Error(`Failed to prefetch ${file}: ${response.status}`);
        }
      })
    ).catch(error => {
      console.warn('[Fillup] Face model prefetch failed', error);
    });
  }, []);

  const [dateOfBirth, setDateOfBirth] = useState(prefillData?.dateOfBirth || '');
  const [consent, setConsent] = useState(true);
  const [guardianPhone, setGuardianPhone] = useState(prefillData?.guardianPhone || '');
  const [patientName, setPatientName] = useState(prefillData?.patientName || '');
  const [patientGender, setPatientGender] = useState(prefillData?.patientGender || '');
  const [screenSize, setScreenSize] = useState(Number(localStorage.getItem('screenSize')) || 0);
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [selectedVersions, setSelectedVersions] = useState<StimulusVersion[]>(['1', '2']);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dobInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleBack = () => {
      resetTestData();
      navigate(backTarget, { replace: true });
    };

    window.addEventListener('popstate', handleBack);
    return () => window.removeEventListener('popstate', handleBack);
  }, [resetTestData, navigate, backTarget]);

  const handleNextClick = async () => {
    if (dateOfBirth) {
      const year = new Date(dateOfBirth).getFullYear();
      const currentYear = new Date().getFullYear();
      if (year < 1900 || year > currentYear) {
        toast.error('Please enter a valid date of birth');
        return;
      }
    }

    const data = validate(fillupFormSchema, {
      patientName,
      dateOfBirth,
      patientGender: patientGender || undefined,
      guardianPhone,
      screenSize,
      selectedLanguage: selectedLanguage || undefined,
      stimulusVersions: selectedVersions,
      consent,
    });

    if (!data) return;

    const patientInfo = {
      name: data.patientName,
      dob: data.dateOfBirth,
      gender: data.patientGender,
      guardian_phone: data.guardianPhone ?? '',
    };

    const metadata = {
      camera_resolution: { width: 0, height: 0 },
      screen_resolution: { width: 0, height: 0 },
      screen_size_inch: data.screenSize,
      video_language: data.selectedLanguage,
      camera_used: '',
    };

    // Canonical play order: version 1 before version 2 regardless of click order.
    const orderedVersions = [...data.stimulusVersions].sort() as StimulusVersion[];

    // Sent with every create so the server derives the same session id the
    // client can compute locally — makes the create replayable/idempotent and
    // lets a fully-offline device start the test with the final id.
    const clientSessionId = crypto.randomUUID();
    const payload: ResearchSessionCreatePayload = {
      patient_info: patientInfo,
      metadata,
      data_usage_consent: data.consent,
      stimulus_versions: orderedVersions,
      client_session_id: clientSessionId,
      ...(campChild ? { camp_name: campChild.campName } : {}),
    };

    const startTest = async (sessionId: string) => {
      if (campChild) {
        // Link the roster row to this session and queue its ground truth
        // before entering the flow, so even a crash mid-test leaves the
        // linkage (and the queued label) intact.
        await linkChildToSession(campChild.id, clientSessionId, sessionId);
      }
      setTestData({
        session_id: sessionId,
        patient_info: patientInfo,
        metadata,
        data_usage_consent: data.consent,
        stimulus_versions: orderedVersions,
        video_count: orderedVersions.length,
        run_queue: orderedVersions.map((_, index) => index + 1),
        current_video_index: 1,
        questionnaire_completed: false,
        uploaded_test_ids: [],
        camp_child_id: campChild?.id ?? null,
        camp_id: campChild?.campId ?? null,
        camp_name: campChild?.campName ?? null,
      });
      // Camp mode skips the instructions page — many children back-to-back.
      navigate(campChild ? '/test/webcam-test' : '/test/instructions');
    };

    const startOffline = async () => {
      const token = useAuthStore.getState().token;
      const uid = getUidFromToken(token, true);
      const prereqs = await canTakeTestOffline({
        hasAuth: !!token,
        uid,
        videoLanguage: data.selectedLanguage as StimulusLanguage,
        stimulusVersions: orderedVersions,
      });
      if (!prereqs.ok || !uid) {
        toast.error(
          `This device isn't prepared for offline tests (missing: ${
            prereqs.missing.join(', ') || 'authentication'
          }). Tap "Prepare this device" on the dashboard while online.`
        );
        return;
      }

      const storage = await estimateOfflineStorageUsage();
      if (storage.percent !== null && storage.percent >= 95) {
        toast.error(
          'This device is out of storage. Connect to the internet to sync pending tests before recording more.'
        );
        return;
      }

      const sessionId = await deriveSessionId(uid, clientSessionId);
      const now = Date.now();
      await putPendingSession({
        session_id: sessionId,
        client_session_id: clientSessionId,
        uid,
        payload,
        video_count: orderedVersions.length,
        stimulus_versions: orderedVersions,
        syncStatus: 'pending',
        lastError: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });

      toast.info('No internet — this test will be saved on this device and synced later.');
      await startTest(sessionId);
    };

    setIsSubmitting(true);
    try {
      if (!navigator.onLine) {
        await startOffline();
        return;
      }
      const session = await createResearchSession(payload);
      await startTest(session.session_id);
    } catch (error) {
      // A create that died without an HTTP response (network dropped mid-call)
      // falls back to the offline path — same as starting offline outright.
      if (isAxiosError(error) && !error.response) {
        console.warn('[Fillup] Session create unreachable, falling back to offline', error);
        await startOffline();
        return;
      }
      console.error('[Fillup] Failed to create research session', error);
      toast.error(error instanceof Error ? error.message : 'Failed to start research session');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDateOfBirth(e.target.value);
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedLanguage(e.target.value);
  };

  return (
    <div className="flex flex-col justify-between h-full min-h-screen dark bg-background">
      <div className="flex flex-col justify-center items-center py-8 grow">
        <div className="flex flex-row justify-between items-center px-4 w-full max-w-7xl">
          <div className="flex flex-col gap-6 items-start px-8">
            <div className="inline-block relative m-auto">
              <div className="absolute inset-0 from-blue-500 rounded-lg opacity-60 blur-lg to-primary bg-linar-to-r"></div>
              <span className="relative z-10 text-4xl font-semibold tracking-wide text-foreground">
                Aignosis Research
              </span>
            </div>

            <div className="flex flex-col space-y-4 max-w-sm">
              <p className="text-2xl text-center text-foreground font-manrope">
                Please take the assessment to{' '}
                <span className="text-left">begin with screening</span>
              </p>
              <p className="px-4 py-2 text-sm text-center font-raleway text-muted-foreground">
                Assessment duration: 5 mins per video run
              </p>
            </div>
          </div>

          <div className="mx-8 w-[50vw] rounded-2xl bg-card/40 backdrop-blur-sm p-8 shadow-lg border border-border/50">
            <h2 className="mb-5 text-2xl font-semibold text-center text-card-foreground font-raleway">
              Research screening intake
            </h2>

            {campChild && (
              <p className="mb-4 rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
                Child details come from the camp roster —{' '}
                <span className="text-foreground">{campChild.campName}</span>. To change them, edit
                the roster.
              </p>
            )}

            <form className="space-y-4" autoComplete="off">
              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="child-name-input"
                  className="text-base font-medium text-left text-foreground"
                >
                  {"Child's name"}
                </label>
                <input
                  id="child-name-input"
                  type="text"
                  placeholder="Name"
                  value={patientName}
                  onChange={e => setPatientName(e.target.value)}
                  disabled={!!campChild}
                  className="w-full rounded-lg border border-border bg-input px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="dob-input"
                  className="text-base font-medium text-left text-foreground"
                >
                  {"Child's date of birth"}
                </label>
                <div
                  className="inline-flex w-full"
                  onClick={() => {
                    if (!campChild) dobInputRef.current?.showPicker();
                  }}
                >
                  <input
                    type="date"
                    id="dob-input"
                    name="dob"
                    ref={dobInputRef}
                    value={dateOfBirth}
                    onChange={handleDateChange}
                    disabled={!!campChild}
                    min="1900-01-01"
                    max={new Date().toISOString().split('T')[0]}
                    className="pointer-events-none w-full rounded-lg border border-border bg-input px-4 py-[0.6rem] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="gender-select"
                  className="text-base font-medium text-left text-foreground"
                >
                  {"Child's gender"}
                </label>
                <select
                  id="gender-select"
                  value={patientGender}
                  required
                  onChange={e => setPatientGender(e.target.value as 'male' | 'female' | 'other')}
                  disabled={!!campChild}
                  className="w-full rounded-lg border border-border bg-input px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                >
                  <option value="" disabled className="bg-popover text-muted-foreground">
                    Select Gender
                  </option>
                  {GENDERS.map(gender => (
                    <option
                      key={gender.value}
                      value={gender.value}
                      className="bg-popover text-popover-foreground"
                    >
                      {gender.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="guardian-phone-input"
                  className="text-base font-medium text-left text-foreground"
                >
                  {"Parent/guardian's phone number (optional)"}
                </label>
                <PhoneInput
                  value={guardianPhone}
                  onChange={value => setGuardianPhone(value || '')}
                  defaultCountry="IN"
                  placeholder="Patient Guardian Phone"
                  disabled={!!campChild}
                  className="w-full text-foreground"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="screen-size-select"
                  className="text-base font-medium text-left text-foreground"
                >
                  Screen Size
                </label>
                <select
                  id="screen-size-select"
                  value={screenSize}
                  required
                  onChange={e => {
                    const numValue = Number(e.target.value);
                    setScreenSize(numValue);
                    localStorage.setItem('screenSize', numValue.toString());
                  }}
                  className="w-full rounded-lg border border-border bg-input px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="0" disabled className="bg-popover text-muted-foreground">
                    Select Screen Size (inches)
                  </option>
                  {SCREEN_SIZES.map(size => (
                    <option key={size} value={size} className="bg-popover text-popover-foreground">
                      {size}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <span className="text-base font-medium text-left text-foreground">
                  Videos to capture
                </span>
                <div className="flex flex-col gap-2 w-full rounded-lg border border-border bg-input px-4 py-2.5">
                  {STIMULUS_VERSION_OPTIONS.map(option => (
                    <label
                      key={option.value}
                      htmlFor={`stimulus-version-${option.value}`}
                      className="flex items-center gap-3 cursor-pointer text-foreground"
                    >
                      <input
                        id={`stimulus-version-${option.value}`}
                        type="checkbox"
                        checked={selectedVersions.includes(option.value)}
                        onChange={e =>
                          setSelectedVersions(prev =>
                            e.target.checked
                              ? [...prev, option.value]
                              : prev.filter(v => v !== option.value)
                          )
                        }
                        className="w-4 h-4 accent-primary focus:ring-2 focus:ring-ring"
                      />
                      <span className="text-sm">
                        {option.label}{' '}
                        <span className="text-muted-foreground">({option.hint})</span>
                      </span>
                    </label>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Each selected video is a full capture run (webcam check, calibration,
                    recording).
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] items-center gap-2 sm:gap-4">
                <label
                  htmlFor="language-select"
                  className="text-base font-medium text-left text-foreground"
                >
                  Language
                </label>
                <select
                  id="language-select"
                  value={selectedLanguage}
                  required
                  onChange={handleLanguageChange}
                  className="w-full rounded-lg border border-border bg-input px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring capitalize"
                >
                  <option value="" disabled className="bg-popover text-muted-foreground">
                    Select Language
                  </option>
                  {LANGUAGES.map(language => (
                    <option
                      key={language}
                      value={language}
                      className="capitalize bg-popover text-popover-foreground"
                    >
                      {language}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-4 mt-6 rounded-lg border border-border bg-muted">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={e => setConsent(e.target.checked)}
                    className="mt-1 w-5 h-5 accent-primary focus:ring-2 focus:ring-ring"
                    id="consent-checkbox"
                  />
                  <div className="flex-1">
                    <label
                      htmlFor="consent-checkbox"
                      className="text-sm cursor-pointer text-foreground"
                    >
                      I consent to data usage for research purposes.{' '}
                      <button
                        type="button"
                        onClick={() => setShowConsentModal(true)}
                        className="underline text-primary hover:text-primary/80"
                      >
                        View details
                      </button>
                    </label>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 justify-center items-center pt-2 max-sm:flex-col">
                <Link
                  to={backTarget}
                  onClick={() => resetTestData()}
                  className="mt-4 flex w-[150px] items-center justify-center rounded-full border border-primary px-6 py-3 font-semibold text-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                >
                  Back
                </Link>

                <button
                  type="button"
                  onClick={handleNextClick}
                  disabled={isSubmitting}
                  className="mt-4 flex w-[150px] items-center justify-center rounded-full border border-primary px-6 py-3 font-semibold text-foreground hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Starting...' : 'Next'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {showConsentModal && (
        <div className="flex fixed inset-0 z-50 justify-center items-center p-4">
          <div
            className="absolute inset-0 backdrop-blur-sm bg-black/50"
            onClick={() => setShowConsentModal(false)}
          ></div>
          <div className="relative max-h-[80vh] w-full max-w-120 overflow-y-auto rounded-2xl bg-card border border-border p-6 shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-card-foreground">Data Usage Consent</h3>
              <button
                onClick={() => setShowConsentModal(false)}
                className="transition-colors text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="text-sm text-muted-foreground">
              <p className="mb-3">
                By providing your consent, you agree that your data may be used for research
                purposes to improve our services and advance understanding of developmental
                disorders in children.
              </p>
              <p className="mb-3">
                <strong className="text-foreground">We ensure:</strong>
              </p>
              <ul className="pl-5 mb-4 space-y-1 list-disc">
                <li>Your data will be securely stored and protected</li>
                <li>Personal information will be anonymized where necessary</li>
                <li>Data will only be used for legitimate research purposes</li>
                <li>You can withdraw consent at any time by contacting us</li>
              </ul>
              <p className="text-xs text-muted-foreground/80">
                For questions about data usage, please contact us at support@aignosis.in
              </p>
            </div>
            <div className="flex justify-end mt-6">
              <button
                onClick={() => setShowConsentModal(false)}
                className="px-4 py-2 rounded-lg transition-colors text-primary-foreground bg-primary hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
