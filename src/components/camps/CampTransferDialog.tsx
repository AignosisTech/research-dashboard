import { useEffect, useMemo, useState } from 'react';

import { AlertTriangle, Building2, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getResearchUphcs,
  type TransferCampResult,
  transferCampToUphc,
  type UphcClinic,
} from '@/lib/api/research';
import type { CampChildWithStatus } from '@/lib/camps/status';
import { putCamp } from '@/lib/offline/db';
import type { CampRecord } from '@/lib/offline/types';

interface CampTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  camp: CampRecord;
  children: CampChildWithStatus[];
  onTransferred: () => void;
}

/**
 * Hands a camp's synced tests over to a UPHC clinic. The server call is
 * idempotent, so a partial failure (network drop, crash) is safely retried
 * with the same inputs.
 */
export const CampTransferDialog = ({
  open,
  onOpenChange,
  camp,
  children,
  onTransferred,
}: CampTransferDialogProps) => {
  const [uphcs, setUphcs] = useState<UphcClinic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedPid, setSelectedPid] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [result, setResult] = useState<TransferCampResult | null>(null);

  // Only children whose session (create + uploads + questionnaire + ground
  // truth) fully reached the server can be handed over.
  const eligible = useMemo(
    () => children.filter(c => c.derivedStatus === 'synced' && c.sessionId),
    [children]
  );
  const leftBehind = useMemo(
    () => children.filter(c => !(c.derivedStatus === 'synced' && c.sessionId)),
    [children]
  );
  const sessionIds = useMemo(
    () => [...new Set(eligible.map(c => c.sessionId as string))],
    [eligible]
  );

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    getResearchUphcs()
      .then(setUphcs)
      .catch((err: unknown) => {
        console.error('[camps] Failed to load UPHC list', err);
        setLoadError(
          navigator.onLine
            ? 'Could not load the UPHC list. Please try again.'
            : 'You are offline — transferring a camp needs an internet connection.'
        );
      });
  }, [open]);

  const resetAndClose = (didTransfer: boolean) => {
    onOpenChange(false);
    setSearch('');
    setSelectedPid(null);
    setConfirmText('');
    setResult(null);
    if (didTransfer) onTransferred();
  };

  const filteredUphcs = useMemo(() => {
    if (!uphcs) return [];
    const text = search.trim().toLowerCase();
    if (!text) return uphcs;
    return uphcs.filter(u => u.clinic_name.toLowerCase().includes(text));
  }, [uphcs, search]);

  const selectedUphc = uphcs?.find(u => u.pid === selectedPid) ?? null;
  const confirmMatches = confirmText.trim() === camp.name;

  const handleTransfer = async () => {
    if (!selectedUphc || sessionIds.length === 0) return;
    if (!navigator.onLine) {
      toast.error('You are offline — transferring a camp needs an internet connection.');
      return;
    }
    setIsTransferring(true);
    try {
      const res = await transferCampToUphc({
        uphc_pid: selectedUphc.pid,
        camp_name: camp.name,
        session_ids: sessionIds,
      });
      setResult(res);

      const failed = res.summary.failed > 0;
      if (!failed) {
        await putCamp({
          ...camp,
          transfer: {
            uphcPid: selectedUphc.pid,
            uphcName: selectedUphc.clinic_name,
            transferredAt: Date.now(),
            sessionIds,
          },
          updatedAt: Date.now(),
        });
        toast.success(`Camp tests transferred to ${selectedUphc.clinic_name}`);
      } else {
        toast.error('Some tests could not be transferred — you can retry safely.');
      }
    } catch (err) {
      console.error('[camps] Transfer failed', err);
      toast.error(err instanceof Error ? err.message : 'Transfer failed. Please try again.');
    } finally {
      setIsTransferring(false);
    }
  };

  const succeeded = result !== null && result.summary.failed === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={value => (value ? onOpenChange(true) : resetAndClose(succeeded))}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Transfer camp tests to a UPHC</DialogTitle>
          <DialogDescription>
            Hands every synced test of “{camp.name}” over to the selected UPHC. The tests will
            appear in that UPHC's clinic dashboard and leave your research data. This cannot be
            undone from this dashboard.
          </DialogDescription>
        </DialogHeader>

        {result === null ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border px-4 py-3 text-sm">
              <p>
                <span className="font-medium">{eligible.length}</span> of {children.length} children
                are synced and will be transferred
                {sessionIds.length !== eligible.length ? ` (${sessionIds.length} sessions)` : ''}.
              </p>
            </div>

            {leftBehind.length > 0 && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <p className="font-medium">
                    {leftBehind.length} {leftBehind.length === 1 ? 'child is' : 'children are'} not
                    synced and will be left behind:
                  </p>
                  <p className="text-muted-foreground">
                    {leftBehind
                      .slice(0, 6)
                      .map(c => c.name)
                      .join(', ')}
                    {leftBehind.length > 6 ? ` and ${leftBehind.length - 6} more` : ''}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Let the sync finish (or record them) first, then run the transfer again.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Destination UPHC</Label>
              {loadError ? (
                <p className="text-sm text-destructive">{loadError}</p>
              ) : uphcs === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading UPHCs…
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Search UPHC by name"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                    {filteredUphcs.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        No UPHC matches “{search}”.
                      </p>
                    ) : (
                      filteredUphcs.map(uphc => (
                        <button
                          key={uphc.pid}
                          type="button"
                          onClick={() => setSelectedPid(uphc.pid)}
                          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                            selectedPid === uphc.pid
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-muted'
                          }`}
                        >
                          <Building2 className="h-4 w-4 shrink-0" />
                          {uphc.clinic_name}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="transfer-confirm">
                Type the camp name (<span className="font-mono">{camp.name}</span>) to confirm
              </Label>
              <Input
                id="transfer-confirm"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={camp.name}
                autoComplete="off"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div
              className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                succeeded
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              {succeeded ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <div>
                <p className="font-medium">
                  {result.summary.transferred} transferred, {result.summary.already_transferred}{' '}
                  already transferred, {result.summary.skipped} skipped, {result.summary.failed}{' '}
                  failed.
                </p>
                {!succeeded && (
                  <p className="mt-1 text-muted-foreground">
                    The transfer is safe to retry — already-moved tests are not duplicated.
                  </p>
                )}
              </div>
            </div>

            {result.sessions.some(s => s.status === 'failed' || s.status === 'skipped') && (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2 text-xs">
                {result.sessions
                  .filter(s => s.status === 'failed' || s.status === 'skipped')
                  .map(s => (
                    <p key={s.session_id} className="text-muted-foreground">
                      <span className="font-mono">{s.session_id.slice(0, 8)}…</span> — {s.status}
                      {s.reason ? ` (${s.reason})` : ''}
                    </p>
                  ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="outline" onClick={() => resetAndClose(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  !selectedUphc || !confirmMatches || sessionIds.length === 0 || isTransferring
                }
                onClick={() => void handleTransfer()}
              >
                {isTransferring && <Loader2 className="h-4 w-4 animate-spin" />}
                Transfer {sessionIds.length > 0 ? `${sessionIds.length} sessions` : ''}
              </Button>
            </>
          ) : succeeded ? (
            <Button onClick={() => resetAndClose(true)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => resetAndClose(false)}>
                Close
              </Button>
              <Button
                variant="destructive"
                disabled={isTransferring}
                onClick={() => void handleTransfer()}
              >
                {isTransferring && <Loader2 className="h-4 w-4 animate-spin" />}
                Retry failed
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
