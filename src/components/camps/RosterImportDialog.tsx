import { useRef, useState } from 'react';

import { AlertTriangle, FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedRosterRow, RosterParseResult } from '@/lib/camps/roster';
import { bulkPutCampChildren } from '@/lib/offline/db';
import type { CampChildRecord } from '@/lib/offline/types';

interface RosterImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campId: string;
  uid: string;
  existingChildren: CampChildRecord[];
  onImported: () => Promise<void> | void;
}

const childKey = (name: string, dob: string) => `${name.trim().toLowerCase()}|${dob}`;

export const RosterImportDialog = ({
  open,
  onOpenChange,
  campId,
  uid,
  existingChildren,
  onImported,
}: RosterImportDialogProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<RosterParseResult | null>(null);
  const [fileName, setFileName] = useState('');

  const reset = () => {
    setResult(null);
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (file: File) => {
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      toast.error('Please use a .xlsx or .csv file');
      return;
    }
    setIsParsing(true);
    setFileName(file.name);
    try {
      const { parseRosterFile } = await import('@/lib/camps/roster');
      setResult(await parseRosterFile(file));
    } catch (err) {
      console.error('[camps] Roster parse failed', err);
      toast.error('Could not read that file. Is it a valid .xlsx or .csv?');
      reset();
    } finally {
      setIsParsing(false);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    if (isParsing) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  // Split parsed rows into importable vs duplicates (against the camp and
  // within the file itself) so nothing is skipped silently.
  const partition = (rows: ParsedRosterRow[]) => {
    const seen = new Set(existingChildren.map(c => childKey(c.name, c.dob)));
    const importable: ParsedRosterRow[] = [];
    const duplicates: ParsedRosterRow[] = [];
    for (const row of rows) {
      const key = childKey(row.name, row.dob);
      if (seen.has(key)) duplicates.push(row);
      else {
        seen.add(key);
        importable.push(row);
      }
    }
    return { importable, duplicates };
  };

  const { importable, duplicates } = partition(result?.valid ?? []);
  const warningCount = importable.filter(r => r.warnings.length > 0).length;

  const handleImport = async () => {
    if (importable.length === 0) return;
    setIsImporting(true);
    try {
      const now = Date.now();
      const baseIndex = existingChildren.length;
      await bulkPutCampChildren(
        importable.map((row, index) => ({
          id: crypto.randomUUID(),
          campId,
          uid,
          rowIndex: baseIndex + index,
          name: row.name,
          dob: row.dob,
          gender: row.gender,
          guardianPhone: row.guardianPhone,
          groundTruth: row.groundTruth,
          notes: row.notes,
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        }))
      );
      toast.success(
        `Imported ${importable.length} ${importable.length === 1 ? 'child' : 'children'}` +
          (duplicates.length ? ` (${duplicates.length} duplicates skipped)` : '')
      );
      reset();
      onOpenChange(false);
      await onImported();
    } catch (err) {
      console.error('[camps] Roster import failed', err);
      toast.error('Import failed — nothing was saved');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import roster</DialogTitle>
          <DialogDescription>
            Upload the camp Excel (.xlsx or .csv). Use “Download template” for the expected columns:
            Name, DOB, Gender, and optionally Guardian Phone, Ground Truth, Notes.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.csv"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {!result && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isParsing}
            onDragOver={event => {
              event.preventDefault();
              if (!isParsing) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 transition-colors ${
              isDragging
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border text-muted-foreground hover:border-primary hover:text-foreground'
            }`}
          >
            {isParsing ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-8 w-8" />
            )}
            <span>
              {isParsing
                ? `Reading ${fileName}…`
                : isDragging
                  ? 'Drop the roster file here'
                  : 'Drag & drop the roster file here, or click to browse'}
            </span>
          </button>
        )}

        {result && result.missingColumns.length > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">
                Missing required columns: {result.missingColumns.join(', ')}
              </p>
              <p className="text-muted-foreground">
                The first row must contain headers. Download the template to see the expected
                format.
              </p>
            </div>
          </div>
        )}

        {result && result.missingColumns.length === 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">{importable.length} ready to import</Badge>
              {warningCount > 0 && (
                <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  {warningCount} with warnings
                </Badge>
              )}
              {duplicates.length > 0 && (
                <Badge variant="outline">{duplicates.length} duplicates — will be skipped</Badge>
              )}
              {result.invalid.length > 0 && (
                <Badge variant="destructive">
                  {result.invalid.length} invalid — will be skipped
                </Badge>
              )}
            </div>

            {result.invalid.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Row</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Problems</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.invalid.map(row => (
                      <TableRow key={row.rowNumber}>
                        <TableCell>{row.rowNumber}</TableCell>
                        <TableCell>{row.name}</TableCell>
                        <TableCell className="text-destructive">{row.errors.join('; ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {importable.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>DOB</TableHead>
                      <TableHead>Gender</TableHead>
                      <TableHead>Ground truth</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importable.map(row => (
                      <TableRow key={row.rowNumber}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell>{row.dob}</TableCell>
                        <TableCell className="capitalize">{row.gender}</TableCell>
                        <TableCell>
                          {row.warnings.length > 0 ? (
                            <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              <span className="text-xs">{row.warnings.join('; ')}</span>
                            </span>
                          ) : (
                            row.groundTruthRaw || <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result && (
            <Button variant="outline" onClick={reset} disabled={isImporting}>
              Choose another file
            </Button>
          )}
          <Button
            onClick={() => void handleImport()}
            disabled={!result || importable.length === 0 || isImporting}
          >
            {isImporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Import ${importable.length || ''}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
