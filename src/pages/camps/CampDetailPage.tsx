import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { ArrowLeft, Download, Upload, WifiOff } from 'lucide-react';
import { toast } from 'sonner';

import { CampChildrenTable } from '@/components/camps/CampChildrenTable';
import { RosterImportDialog } from '@/components/camps/RosterImportDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCampDetail, useCampUid } from '@/lib/camps/useCampData';
import { getOfflinePackStatus } from '@/lib/offline/resourceCache';

export const CampDetailPage = () => {
  const { campId } = useParams<{ campId: string }>();
  const uid = useCampUid();
  const { camp, children, isLoading, refresh } = useCampDetail(campId);
  const [importOpen, setImportOpen] = useState(false);
  const [offlineReady, setOfflineReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!uid) return;
    void getOfflinePackStatus(uid).then(status => setOfflineReady(status.ready));
  }, [uid]);

  const handleDownloadTemplate = async () => {
    try {
      const { downloadRosterTemplate } = await import('@/lib/camps/roster');
      await downloadRosterTemplate();
    } catch (err) {
      console.error('[camps] Template download failed', err);
      toast.error('Could not generate the template');
    }
  };

  if (!isLoading && !camp) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <p>This camp no longer exists on this device.</p>
        <Button asChild variant="outline">
          <Link to="/camps">Back to camps</Link>
        </Button>
      </div>
    );
  }

  const recordedCount = children.filter(c => c.status === 'recorded').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back to camps">
            <Link to="/camps">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h2 className="text-xl font-semibold">{camp?.name ?? '…'}</h2>
            {camp?.location && <p className="text-sm text-muted-foreground">{camp.location}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void handleDownloadTemplate()}>
            <Download className="h-4 w-4" />
            Download template
          </Button>
          <Button onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" />
            Import roster
          </Button>
        </div>
      </div>

      {offlineReady === false && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-500" />
          <p>
            This device isn't prepared for offline recording yet. While you still have internet,
            open the{' '}
            <Link to="/dashboard" className="underline">
              Dashboard
            </Link>{' '}
            and tap “Prepare this device” — camps usually have no connectivity.
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Children</CardTitle>
          <CardDescription>
            {children.length === 0
              ? 'Import an Excel roster to register the children in this camp.'
              : `${recordedCount} of ${children.length} recorded`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : camp ? (
            <CampChildrenTable camp={camp} children={children} onChanged={refresh} />
          ) : null}
        </CardContent>
      </Card>

      {camp && uid && (
        <RosterImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          campId={camp.id}
          uid={uid}
          existingChildren={children}
          onImported={refresh}
        />
      )}
    </div>
  );
};
