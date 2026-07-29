import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { isAxiosError } from 'axios';
import { toast } from 'sonner';

import { Questionnaire, type QuestionnaireData } from '@/components/test/Questionnaire';
import { TestSubmitLoader } from '@/components/test/TestSubmitLoader';
import { type ResearchTestUploadResponse, submitResearchQuestionnaire } from '@/lib/api/research';
import type { QuestionnaireData as ApiQuestionnaireData } from '@/lib/api/screening';
import { markCampChildRecorded } from '@/lib/camps/recordFlow';
import { autismFacts } from '@/lib/constants/facts';
import { putPendingQuestionnaire } from '@/lib/offline/db';
import { getUidFromToken } from '@/lib/offline/jwt';
import { processSyncQueue } from '@/lib/offline/syncManager';
import { queryClient } from '@/lib/react-query/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { useTestStore } from '@/stores/testStore';

const NEW_FACT_INTERVAL = 7000;

export const QuestionnairePage = () => {
  const navigate = useNavigate();
  const testData = useTestStore(s => s.testData);
  const setTestData = useTestStore(s => s.setTestData);
  const uploadPromises = useTestStore(s => s.uploadPromises);
  const clearUploadPromises = useTestStore(s => s.clearUploadPromises);
  const uploadProgress = useTestStore(s => s.uploadProgress);

  const [factIndex, setFactIndex] = useState(0);
  const [submissionPhase, setSubmissionPhase] = useState<'upload' | 'questionnaire' | 'finishing'>(
    'upload'
  );
  const [isFormFilled, setIsFormFilled] = useState(false);
  const [queuedQuestionnaire, setQueuedQuestionnaire] = useState<QuestionnaireData | null>(null);
  const [skippedQuestionnaire, setSkippedQuestionnaire] = useState(false);

  const isProcessingRef = useRef(false);

  useEffect(() => {
    if (uploadPromises.length === 0 || !testData.session_id) {
      navigate('/dashboard', { replace: true });
    }
  }, [uploadPromises.length, testData.session_id, navigate]);

  // A resumed session may already have its questionnaire — the server allows
  // only one per session, so skip straight to awaiting the uploads.
  useEffect(() => {
    if (testData.questionnaire_completed && !isFormFilled) {
      setSkippedQuestionnaire(true);
      setIsFormFilled(true);
    }
  }, [testData.questionnaire_completed, isFormFilled]);

  useEffect(() => {
    if (isFormFilled) {
      const factInterval = setInterval(() => {
        setFactIndex(prevIndex => (prevIndex + 1) % autismFacts.length);
      }, NEW_FACT_INTERVAL);

      return () => clearInterval(factInterval);
    }
  }, [isFormFilled]);

  useEffect(() => {
    const processSubmission = async () => {
      if (uploadPromises.length === 0 || isProcessingRef.current || !testData.session_id) return;
      const isSkipped = skippedQuestionnaire && !queuedQuestionnaire;
      const hasQuestionnaire = Boolean(queuedQuestionnaire);
      if (!isFormFilled || (!isSkipped && !hasQuestionnaire)) return;

      isProcessingRef.current = true;

      try {
        setSubmissionPhase('upload');
        const uploadResponses = await Promise.all(uploadPromises);
        // Runs saved locally (offline) resolve without a tid.
        const serverResponses = uploadResponses.filter(
          (r): r is ResearchTestUploadResponse => !('offline' in r)
        );
        const anyLocal = serverResponses.length < uploadResponses.length;
        const lastTid = serverResponses[serverResponses.length - 1]?.tid;
        if (lastTid) {
          setTestData({ test_id: lastTid });
        }

        const questionnaireData =
          hasQuestionnaire && queuedQuestionnaire
            ? {
                ...queuedQuestionnaire,
                signsBefore3Years: queuedQuestionnaire.signsBefore3Years || '',
                strugglesDailyTasks: queuedQuestionnaire.strugglesDailyTasks || '',
              }
            : null;

        const queueQuestionnaireLocally = async (data: ApiQuestionnaireData) => {
          const uid = getUidFromToken(useAuthStore.getState().token, true) ?? '';
          await putPendingQuestionnaire({
            session_id: testData.session_id!,
            uid,
            questionnaire: data,
            syncStatus: 'pending',
            lastError: null,
            attempts: 0,
            createdAt: Date.now(),
          });
        };

        if (questionnaireData) {
          setSubmissionPhase('questionnaire');
          if (anyLocal || !navigator.onLine) {
            // The server 409s until every run is uploaded, and at least one run
            // is still local — queue the questionnaire for the sync engine.
            await queueQuestionnaireLocally(questionnaireData);
          } else {
            try {
              await submitResearchQuestionnaire(testData.session_id, questionnaireData);
            } catch (err) {
              // Connection died — the answers are irreplaceable, so persist
              // them locally instead of failing the whole flow.
              if (isAxiosError(err) && !err.response) {
                await queueQuestionnaireLocally(questionnaireData);
              } else {
                throw err;
              }
            }
          }
        } else {
          setSubmissionPhase('finishing');
        }

        if (anyLocal) {
          toast.info('Saved on this device — everything will upload automatically when online.');
          void processSyncQueue();
        }

        // The session now has its uploads (and questionnaire); drop the cached
        // dashboard list so the completed session shows without a manual reload.
        void queryClient.invalidateQueries({ queryKey: ['researchSessions'] });

        if (testData.camp_child_id) {
          await markCampChildRecorded(testData.camp_child_id);
        }

        clearUploadPromises();
        navigate('/test/thankyou', { replace: true });
      } catch (err) {
        console.error('Submission error:', err);
        toast.error('Failed to submit. Please try again.');
        clearUploadPromises();
        navigate('/test/error', { replace: true });
      } finally {
        isProcessingRef.current = false;
      }
    };

    processSubmission();
  }, [
    isFormFilled,
    queuedQuestionnaire,
    skippedQuestionnaire,
    uploadPromises,
    testData.session_id,
    testData.camp_child_id,
    setTestData,
    clearUploadPromises,
    navigate,
  ]);

  useEffect(() => {
    window.history.pushState(null, '', window.location.href);

    const handleBackButton = () => {
      window.history.pushState(null, '', window.location.href);
      if (!isFormFilled) {
        toast.info('Please complete or skip the questionnaire before leaving.');
      }
    };

    window.addEventListener('popstate', handleBackButton);

    return () => {
      window.removeEventListener('popstate', handleBackButton);
    };
  }, [isFormFilled]);

  if (uploadPromises.length === 0) {
    return null;
  }

  return (
    <div className="dark flex min-h-screen flex-col items-center justify-center bg-background">
      {!isFormFilled ? (
        <Questionnaire
          setIsFormFilled={setIsFormFilled}
          onFormCollected={data => setQueuedQuestionnaire(data)}
          onSkip={() => {
            setSkippedQuestionnaire(true);
            setIsFormFilled(true);
          }}
        />
      ) : (
        <TestSubmitLoader
          factIndex={factIndex}
          phase={submissionPhase}
          uploadProgress={uploadProgress}
        />
      )}
    </div>
  );
};
