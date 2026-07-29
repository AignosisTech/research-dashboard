import { Link, useNavigate } from 'react-router';

import { ArrowRight, Play } from 'lucide-react';

import { DraftRecoveryBanner } from '@/components/dashboard/DraftRecoveryBanner';
import { OfflinePackCard } from '@/components/dashboard/OfflinePackCard';
import { PendingUploadsCard } from '@/components/dashboard/PendingUploadsCard';
import { SessionsTable } from '@/components/dashboard/SessionsTable';
import { StorageQuotaBanner } from '@/components/dashboard/StorageQuotaBanner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useQuery } from '@/hooks/useQuery';
import { getResearchSessionsOfflineAware } from '@/lib/offline/sessions';

export const Dashboard = () => {
  const navigate = useNavigate();

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['researchSessions'],
    queryFn: getResearchSessionsOfflineAware,
    showErrorToast: false,
    // Always refetch when landing here — a session may have completed, been
    // resumed, or had a recording recovered since this list was last fetched.
    staleTime: 0,
  });

  const handleTakeTest = () => {
    navigate('/test/fillup');
  };

  return (
    <>
      <title>Aignosis Research | Dashboard</title>
      <div className="flex flex-col space-y-8 grow">
        <StorageQuotaBanner />
        <DraftRecoveryBanner />
        <PendingUploadsCard />
        <OfflinePackCard />
        <Card className="bg-linear-to-br from-primary/5 via-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-6 py-3">
            <div className="flex gap-6 justify-between items-center">
              <div>
                <h2 className="mb-1 text-lg font-semibold text-foreground">
                  Start a research screening session
                </h2>
                <p className="text-sm text-muted-foreground">
                  Choose which stimulus videos to capture (a full run each), then complete one
                  questionnaire
                </p>
              </div>
              <Button onClick={handleTakeTest} size="lg" className="gap-2 shrink-0">
                <Play className="w-5 h-5 fill-current" />
                Start Session
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="flex-1 gap-3.5">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Sessions</CardTitle>
              <CardDescription>Your latest research capture sessions</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to="/sessions">
                View all
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex-1">
            <SessionsTable
              sessions={sessions}
              isLoading={isLoading}
              invalidateQueries={['researchSessions', 'allResearchSessions']}
              emptyState={
                <div className="flex flex-col justify-center items-center py-12 h-full">
                  <p className="mb-1 text-base font-medium text-muted-foreground">
                    No sessions yet
                  </p>
                  <p className="mb-6 text-sm text-muted-foreground/70">
                    Start your first research session to see it here
                  </p>
                  <Button onClick={handleTakeTest} className="gap-2">
                    <Play className="w-4 h-4" />
                    Start Session
                  </Button>
                </div>
              }
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
};
