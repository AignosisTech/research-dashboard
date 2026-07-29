import { useMemo, useState } from 'react';

import { ChevronLeft, ChevronRight, Search, WifiOff } from 'lucide-react';

import { sessionOutcomeLabels } from '@/components/dashboard/sessionLabels';
import { SessionsTable } from '@/components/dashboard/SessionsTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useQuery } from '@/hooks/useQuery';
import { getResearchSessions } from '@/lib/api/research';

const PAGE_SIZE = 20;

/**
 * Paginated browser over every research session — cursor-stack pagination and
 * client-side search over the current page, mirroring core/dashboard's
 * AssessmentHistory. Online-only: the offline story is the dashboard's cached
 * recents card.
 */
export const AllSessions = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['allResearchSessions', currentCursor ?? null],
    queryFn: async () => {
      const page = await getResearchSessions({
        pageSize: PAGE_SIZE,
        lastCursor: currentCursor,
        // The aggregation count adds latency — only pay for it on page 1.
        includeTotal: !currentCursor,
      });
      if (page.total_count !== undefined) setTotalCount(page.total_count);
      return page;
    },
    showErrorToast: false,
    staleTime: 0,
  });

  const sessions = useMemo(() => data?.items ?? [], [data]);
  const nextCursor = data?.next_cursor ?? null;
  const hasMore = data?.has_more ?? false;

  const handleNextPage = () => {
    if (!nextCursor || !hasMore || isLoading) return;
    setCursorHistory(prev => [...prev, currentCursor ?? '']);
    setCurrentCursor(nextCursor);
    setCurrentPage(prev => prev + 1);
  };

  const handlePreviousPage = () => {
    if (currentPage <= 1 || isLoading) return;
    const previous = cursorHistory[cursorHistory.length - 1];
    setCursorHistory(prev => prev.slice(0, -1));
    setCurrentCursor(previous === '' || previous === undefined ? undefined : previous);
    setCurrentPage(prev => prev - 1);
  };

  // Search filters the current page only — same as core/dashboard.
  const filteredSessions = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(session => {
      const haystack = [
        session.patient_info?.name ?? '',
        session.session_id,
        session.status ?? '',
        session.camp_name ?? '',
        ...sessionOutcomeLabels(session),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [sessions, searchTerm]);

  const startItem = (currentPage - 1) * PAGE_SIZE + 1;
  const endItem = (currentPage - 1) * PAGE_SIZE + sessions.length;

  const canGoPrevious = currentPage > 1 && !isLoading;
  const canGoNext = !!nextCursor && hasMore && !isLoading;

  // A pager on a single page is noise — show it only once there is a page 2.
  const showPagination = currentPage > 1 || hasMore;

  return (
    <>
      <title>Aignosis Research | All Sessions</title>
      <Card className="gap-3.5">
        <CardHeader>
          <CardTitle>All Sessions</CardTitle>
          <CardDescription>
            {totalCount !== null && sessions.length > 0
              ? `Showing ${startItem}–${endItem} of ${totalCount} sessions`
              : 'Every research capture session for this account'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search this page by name, status, camp…"
              className="pl-9"
            />
          </div>

          {isError ? (
            <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
              <WifiOff className="h-4 w-4 shrink-0 text-amber-500" />
              <p>
                Browsing all sessions needs a connection — recent sessions are available on the
                Dashboard even offline.
              </p>
            </div>
          ) : (
            <>
              <SessionsTable
                sessions={filteredSessions}
                isLoading={isLoading}
                invalidateQueries={['allResearchSessions', 'researchSessions']}
                emptyState={
                  <div className="flex flex-col justify-center items-center py-12">
                    <p className="text-base font-medium text-muted-foreground">
                      {searchTerm
                        ? `No sessions on this page match “${searchTerm}”`
                        : 'No sessions yet'}
                    </p>
                  </div>
                }
              />

              {searchTerm && sessions.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Showing {filteredSessions.length} of {sessions.length} sessions on this page.
                  Search only covers the current page.
                </p>
              )}

              {showPagination && (
                <div className="flex items-center justify-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={!canGoPrevious}
                    onClick={handlePreviousPage}
                  >
                    <ChevronLeft className="size-4" />
                    Previous
                  </Button>
                  <span className="px-3 text-sm text-muted-foreground">Page {currentPage}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={!canGoNext}
                    onClick={handleNextPage}
                  >
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
};
