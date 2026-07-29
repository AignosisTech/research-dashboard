import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';

import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { TestRouteGuard } from '@/components/layout/TestRouteGuard';
import { Toaster } from '@/components/ui/sonner';
import { useAuthInitialization } from '@/hooks/useAuthInitialization';
import { setNavigate } from '@/lib/api/client';
import { LoginPage } from '@/pages/auth/LoginPage';
import { CampDetailPage } from '@/pages/camps/CampDetailPage';
import { CampsPage } from '@/pages/camps/CampsPage';
import { AllSessions } from '@/pages/dashboard/AllSessions';
import { Dashboard } from '@/pages/dashboard/Dashboard';
import { Calibration } from '@/pages/test/Calibration';
import { Fillup } from '@/pages/test/Fillup';
import { Instructions } from '@/pages/test/Instructions';
import { QuestionnairePage } from '@/pages/test/QuestionnairePage';
import { TestError } from '@/pages/test/TestError';
import { ThankYou } from '@/pages/test/ThankYou';
import { VideoPlayback } from '@/pages/test/VideoPlayback';
import { WebcamMicTest } from '@/pages/test/WebcamMicTest';

function App() {
  const navigate = useNavigate();
  useAuthInitialization();

  useEffect(() => {
    setNavigate(navigate);
  }, [navigate]);

  return (
    <>
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardLayout title="Research Dashboard" description="Research data collection">
                  <Dashboard />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sessions"
            element={
              <ProtectedRoute>
                <DashboardLayout title="All Sessions" description="Every research capture session">
                  <AllSessions />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/camps"
            element={
              <ProtectedRoute>
                <DashboardLayout title="Camp Mode" description="Field camp data collection">
                  <CampsPage />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/camps/:campId"
            element={
              <ProtectedRoute>
                <DashboardLayout title="Camp Mode" description="Field camp data collection">
                  <CampDetailPage />
                </DashboardLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/fillup"
            element={
              <ProtectedRoute>
                <Fillup />
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/instructions"
            element={
              <ProtectedRoute>
                <TestRouteGuard>
                  <Instructions />
                </TestRouteGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/webcam-test"
            element={
              <ProtectedRoute>
                <TestRouteGuard>
                  <WebcamMicTest />
                </TestRouteGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/calibration"
            element={
              <ProtectedRoute>
                <TestRouteGuard>
                  <Calibration />
                </TestRouteGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/video"
            element={
              <ProtectedRoute>
                <TestRouteGuard>
                  <VideoPlayback />
                </TestRouteGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/questionnaire"
            element={
              <ProtectedRoute>
                <TestRouteGuard>
                  <QuestionnairePage />
                </TestRouteGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/thankyou"
            element={
              <ProtectedRoute>
                <ThankYou />
              </ProtectedRoute>
            }
          />
          <Route
            path="/test/error"
            element={
              <ProtectedRoute>
                <TestError />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </ErrorBoundary>
      <Toaster richColors position="top-right" />
    </>
  );
}

export { App };
