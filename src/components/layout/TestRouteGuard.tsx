import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';

import { getTestExitDestination, resolveCampId } from '@/lib/camps/campOrigin';
import { testExitPath } from '@/lib/camps/recordFlow';
import { useTestStore } from '@/stores/testStore';

interface TestRouteGuardProps {
  children: React.ReactNode;
}

export const TestRouteGuard = ({ children }: TestRouteGuardProps) => {
  // Select only the fields this guard reads — subscribing to the whole store
  // would re-render the entire capture subtree on every upload-progress tick.
  const patientName = useTestStore(s => s.testData.patient_info.name);
  const patientDob = useTestStore(s => s.testData.patient_info.dob);
  const sessionId = useTestStore(s => s.testData.session_id);
  const videoCount = useTestStore(s => s.testData.video_count);
  const campId = useTestStore(s => s.testData.camp_id);
  const location = useLocation();

  const hasRequiredData =
    patientName.trim() !== '' &&
    patientDob.trim() !== '' &&
    sessionId !== null &&
    sessionId.trim() !== '' &&
    (videoCount === 1 || videoCount === 2);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasRequiredData) {
        event.preventDefault();
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasRequiredData]);

  if (!hasRequiredData) {
    // A confirmed exit wipes the store before its navigation lands, so this
    // render races it — follow the recorded destination instead of Fillup.
    const exitDestination = getTestExitDestination();
    if (exitDestination) {
      return <Navigate to={exitDestination} replace />;
    }
    // Camp one-tap sessions never use the intake form — return them to their
    // roster instead of a blank Fillup with a dashboard back-target. The
    // per-tab origin also covers a mid-session reload, which empties the store.
    const originCampId = resolveCampId(campId);
    if (originCampId) {
      return <Navigate to={testExitPath(originCampId)} replace />;
    }
    return <Navigate to="/test/fillup" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};
