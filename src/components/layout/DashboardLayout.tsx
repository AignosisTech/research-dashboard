import { useEffect } from 'react';

import { AnimatePresence, motion } from 'motion/react';

import { PendingSyncBadge } from '@/components/dashboard/PendingSyncBadge';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { clearCampOrigin } from '@/lib/camps/campOrigin';
import { reconcileWithServer } from '@/lib/offline/reconcile';
import { useOfflineSyncLifecycle } from '@/lib/offline/useSyncStatus';

import { AppSidebar } from './AppSidebar';

interface DashboardLayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

export const DashboardLayout = ({ children, title, description }: DashboardLayoutProps) => {
  useOfflineSyncLifecycle();

  // On landing, dedupe the offline queue against what the server already has
  // (kicks a sync pass itself when done).
  useEffect(() => {
    void reconcileWithServer();
  }, []);

  // Reaching any dashboard-side surface means the capture flow is over — the
  // per-tab camp origin is consumed, so a later dashboard-started session
  // cannot exit to a stale camp.
  useEffect(() => {
    clearCampOrigin();
  }, []);

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset className="bg-muted/30">
        <header className="flex gap-2 items-center px-4 h-14 rounded-t-lg border-b shrink-0 border-border/60 bg-background">
          <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex flex-col flex-1 justify-center min-w-0">
            <h1 className="font-serif text-sm font-semibold truncate text-foreground">{title}</h1>
            <p className="text-xs truncate text-muted-foreground">{description}</p>
          </div>
          <PendingSyncBadge />
          <ThemeSwitcher />
        </header>
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col flex-1 gap-3 p-3 2xl:gap-4 lg:p-4 2xl:p-6"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </SidebarInset>
    </SidebarProvider>
  );
};
