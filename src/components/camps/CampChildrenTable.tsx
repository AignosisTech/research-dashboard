import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { ArrowDown, ArrowUp, Loader2, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getPsychEvalOutcomeLabel } from '@/lib/assessments/outcomes';
import { startCampChildSession } from '@/lib/camps/recordFlow';
import type { CampChildWithStatus, DerivedCampChildStatus } from '@/lib/camps/status';
import { deleteCampChild } from '@/lib/offline/db';
import type { CampRecord } from '@/lib/offline/types';

interface CampChildrenTableProps {
  camp: CampRecord;
  children: CampChildWithStatus[];
  onChanged: () => Promise<void> | void;
}

const STATUS_BADGES: Record<DerivedCampChildStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-muted text-muted-foreground' },
  recorded: {
    label: 'Recorded — syncing',
    className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  synced: {
    label: 'Synced',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  sync_failed: { label: 'Sync failed', className: 'bg-destructive/15 text-destructive' },
};

const STATUS_SORT_ORDER: Record<DerivedCampChildStatus, number> = {
  pending: 0,
  recorded: 1,
  sync_failed: 2,
  synced: 3,
};

type SortKey = 'roster' | 'name' | 'dob' | 'status';
type SortDirection = 'asc' | 'desc';

const groundTruthLabels = (child: CampChildWithStatus): string[] => {
  const codes = child.groundTruth?.outcome_codes;
  if (codes?.length) return codes.map(getPsychEvalOutcomeLabel);
  if (child.groundTruth?.notes) return ['Notes'];
  return [];
};

export const CampChildrenTable = ({ camp, children, onChanged }: CampChildrenTableProps) => {
  const navigate = useNavigate();
  const [childToRerecord, setChildToRerecord] = useState<CampChildWithStatus | null>(null);
  const [childToRemove, setChildToRemove] = useState<CampChildWithStatus | null>(null);
  const [startingChildId, setStartingChildId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('roster');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const visibleChildren = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? children.filter(child => child.name.toLowerCase().includes(query))
      : [...children];

    const direction = sortDirection === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return direction * a.name.localeCompare(b.name);
        case 'dob':
          // ISO dates compare correctly as strings.
          return direction * a.dob.localeCompare(b.dob);
        case 'status':
          return (
            direction * (STATUS_SORT_ORDER[a.derivedStatus] - STATUS_SORT_ORDER[b.derivedStatus])
          );
        default:
          return direction * (a.rowIndex - b.rowIndex);
      }
    });
    return filtered;
  }, [children, search, sortKey, sortDirection]);

  if (children.length === 0) return null;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortDirection === 'asc' ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const handleRecord = async (child: CampChildWithStatus) => {
    setStartingChildId(child.id);
    try {
      // Falls back to the prefilled intake form for camps without settings.
      await startCampChildSession(navigate, child, camp);
    } finally {
      setStartingChildId(null);
    }
  };

  const handleRemove = async () => {
    if (!childToRemove) return;
    await deleteCampChild(childToRemove.id);
    setChildToRemove(null);
    await onChanged();
    toast.success('Removed from roster');
  };

  const sortableHead = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className="flex items-center gap-1 hover:text-foreground transition-colors"
    >
      {label}
      {sortIcon(key)}
    </button>
  );

  return (
    <>
      <div className="mb-4 relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="pl-9"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">{sortableHead('roster', '#')}</TableHead>
            <TableHead>{sortableHead('name', 'Name')}</TableHead>
            <TableHead>{sortableHead('dob', 'DOB')}</TableHead>
            <TableHead>Gender</TableHead>
            <TableHead>Ground truth</TableHead>
            <TableHead>{sortableHead('status', 'Status')}</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleChildren.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                No children match “{search}”
              </TableCell>
            </TableRow>
          ) : (
            visibleChildren.map(child => {
              const badge = STATUS_BADGES[child.derivedStatus];
              const gtLabels = groundTruthLabels(child);
              const isStarting = startingChildId === child.id;
              return (
                <TableRow key={child.id}>
                  <TableCell className="text-muted-foreground">{child.rowIndex + 1}</TableCell>
                  <TableCell className="font-medium">{child.name}</TableCell>
                  <TableCell>{child.dob}</TableCell>
                  <TableCell className="capitalize">{child.gender}</TableCell>
                  <TableCell>
                    {gtLabels.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {gtLabels.map(label => (
                          <Badge key={label} variant="outline" className="font-normal">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge className={badge.className}>{badge.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {child.status === 'pending' ? (
                        <>
                          <Button
                            size="sm"
                            disabled={startingChildId !== null}
                            onClick={() => void handleRecord(child)}
                          >
                            {isStarting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            Record
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setChildToRemove(child)}
                            aria-label={`Remove ${child.name}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={startingChildId !== null}
                          onClick={() => setChildToRerecord(child)}
                        >
                          {isStarting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                          Re-record
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <AlertDialog
        open={!!childToRerecord}
        onOpenChange={open => !open && setChildToRerecord(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-record {childToRerecord?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This starts a new recording session for this child. The previous recording is kept and
              will still sync — it stays visible on the main dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const child = childToRerecord;
                setChildToRerecord(null);
                if (child) void handleRecord(child);
              }}
            >
              Start re-recording
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!childToRemove} onOpenChange={open => !open && setChildToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {childToRemove?.name} from the roster?</AlertDialogTitle>
            <AlertDialogDescription>
              Only children with no recording can be removed. This does not touch anything on the
              server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleRemove()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
