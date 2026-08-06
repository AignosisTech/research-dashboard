import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { AlertTriangle, X } from 'lucide-react';

import { markTestExit } from '@/lib/camps/campOrigin';
import { testExitPath } from '@/lib/camps/recordFlow';
import { useTestStore } from '@/stores/testStore';

interface ExitTestDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
}

export const ExitTestDialog = ({ isOpen, onClose, onConfirm }: ExitTestDialogProps) => {
  const navigate = useNavigate();
  const resetTestData = useTestStore(s => s.resetTestData);

  const handleConfirmExit = () => {
    // Capture the camp origin before resetTestData nulls it.
    const campId = useTestStore.getState().testData.camp_id;
    const destination = testExitPath(campId);
    // The store wipe below re-renders TestRouteGuard while it is still mounted
    // on the /test/* route, and that render races this navigation. Record the
    // destination first so the guard redirects to the same place.
    markTestExit(destination);
    resetTestData();
    onConfirm?.();
    navigate(destination, { replace: true });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/20">
            <AlertTriangle className="h-7 w-7 text-amber-500" />
          </div>

          <h3 className="mb-2 text-xl font-semibold text-card-foreground">Exit Assessment?</h3>

          <p className="mb-6 text-sm text-muted-foreground">
            Are you sure you want to exit? Your progress will be lost and you&apos;ll need to start
            over.
          </p>

          <div className="flex w-full gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 font-medium text-foreground transition-colors hover:bg-muted"
            >
              Continue Test
            </button>
            <button
              onClick={handleConfirmExit}
              className="flex-1 rounded-lg bg-destructive px-4 py-2.5 font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              Exit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Hook to handle back button navigation with exit confirmation
 * Returns the dialog state and a trigger function
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useExitTestDialog = () => {
  const [showExitDialog, setShowExitDialog] = useState(false);

  const handleBackAttempt = useCallback(() => {
    setShowExitDialog(true);
  }, []);

  const closeDialog = useCallback(() => {
    setShowExitDialog(false);
  }, []);

  useEffect(() => {
    window.history.pushState(null, '', window.location.href);

    const handlePopState = () => {
      window.history.pushState(null, '', window.location.href);
      setShowExitDialog(true);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  return {
    showExitDialog,
    handleBackAttempt,
    closeDialog,
  };
};
