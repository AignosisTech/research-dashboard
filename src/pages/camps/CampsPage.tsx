import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Plus, Tent, Trash2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { StimulusVersion } from '@/lib/api/research';
import {
  CAMP_LANGUAGES,
  CAMP_SCREEN_SIZES,
  CAMP_STIMULUS_VERSION_OPTIONS,
} from '@/lib/camps/constants';
import { useCamps, useCampUid } from '@/lib/camps/useCampData';
import { deleteCampCascade, putCamp } from '@/lib/offline/db';
import { STIMULUS_DURATIONS_SEC, type StimulusLanguage } from '@/lib/offline/stimulus';
import type { CampRecord } from '@/lib/offline/types';
import { formatDateShort, formatDuration } from '@/lib/utils';

// Matches the middleware's validate_safe_text so camp_name can never 422 a
// session create later.
const CAMP_NAME_PATTERN = /^[A-Za-z0-9\s\-,'()&]+$/;

export const CampsPage = () => {
  const navigate = useNavigate();
  const uid = useCampUid();
  const { camps, isLoading, refresh } = useCamps();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [newVersions, setNewVersions] = useState<StimulusVersion[]>(['1', '2']);
  const [newLanguage, setNewLanguage] = useState('');
  const [newScreenSize, setNewScreenSize] = useState('');
  const [newConsent, setNewConsent] = useState(true);
  const [campToDelete, setCampToDelete] = useState<CampRecord | null>(null);
  // Durations shown in the version picker follow the selected language.
  const previewLanguage: StimulusLanguage = newLanguage === 'hindi' ? 'hindi' : 'english';

  const resetCreateForm = () => {
    setNewName('');
    setNewLocation('');
    setNewVersions(['1', '2']);
    setNewLanguage('');
    setNewScreenSize('');
    setNewConsent(true);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!uid) return;
    if (!name) {
      toast.error('Please enter a camp name');
      return;
    }
    if (name.length > 100 || !CAMP_NAME_PATTERN.test(name)) {
      toast.error("Camp name may only contain letters, numbers, spaces and - , ' ( ) &");
      return;
    }
    if (newVersions.length === 0) {
      toast.error('Select at least one video version');
      return;
    }
    if (!newLanguage) {
      toast.error('Select the stimulus language');
      return;
    }
    if (!newScreenSize) {
      toast.error('Select the screen size of the camp device');
      return;
    }
    const now = Date.now();
    const campId = crypto.randomUUID();
    await putCamp({
      id: campId,
      uid,
      name,
      location: newLocation.trim() || undefined,
      settings: {
        stimulusVersions: [...newVersions].sort() as StimulusVersion[],
        videoLanguage: newLanguage as 'english' | 'hindi',
        screenSizeInch: Number(newScreenSize),
        dataUsageConsent: newConsent,
      },
      createdAt: now,
      updatedAt: now,
    });
    setCreateOpen(false);
    resetCreateForm();
    toast.success('Camp created');
    // Land on the new camp so the next step (import roster) is right there.
    navigate(`/camps/${campId}`);
  };

  const handleDelete = async () => {
    if (!campToDelete) return;
    await deleteCampCascade(campToDelete.id);
    setCampToDelete(null);
    await refresh();
    toast.success('Camp deleted');
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Camps</CardTitle>
            <CardDescription>
              Field data-collection camps. Rosters live on this device and recordings sync like
              normal research sessions.
            </CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New camp
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : camps.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Tent className="h-8 w-8" />
              <p>No camps yet. Create one, then import its roster from Excel.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {camps.map(camp => (
                  <TableRow key={camp.id}>
                    <TableCell>
                      <Link
                        to={`/camps/${camp.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {camp.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{camp.location || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateShort(new Date(camp.createdAt).toISOString())}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCampToDelete(camp)}
                        aria-label={`Delete ${camp.name}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={next => {
          if (!next) resetCreateForm();
          setCreateOpen(next);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New camp</DialogTitle>
            <DialogDescription>
              The test setup below is asked once here — recording a child jumps straight into the
              test with these settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="camp-name">Camp name</Label>
              <Input
                id="camp-name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Jaipur Screening Camp Aug 2026"
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="camp-location">Location (optional)</Label>
              <Input
                id="camp-location"
                value={newLocation}
                onChange={e => setNewLocation(e.target.value)}
                placeholder="e.g. Govt School, Malviya Nagar"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label>Videos to capture per child</Label>
              <div className="space-y-2 rounded-lg border border-border px-4 py-3">
                {CAMP_STIMULUS_VERSION_OPTIONS.map(option => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      checked={newVersions.includes(option.value)}
                      onCheckedChange={checked =>
                        setNewVersions(prev =>
                          checked ? [...prev, option.value] : prev.filter(v => v !== option.value)
                        )
                      }
                    />
                    <span>
                      {option.label}{' '}
                      <span className="text-muted-foreground">
                        ({option.hint} ·{' '}
                        {formatDuration(STIMULUS_DURATIONS_SEC[option.value][previewLanguage])})
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Language</Label>
                <Select value={newLanguage} onValueChange={setNewLanguage}>
                  <SelectTrigger className="w-full capitalize">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMP_LANGUAGES.map(language => (
                      <SelectItem key={language} value={language} className="capitalize">
                        {language}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Screen size (inches)</Label>
                <Select value={newScreenSize} onValueChange={setNewScreenSize}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select size" />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMP_SCREEN_SIZES.map(size => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-4 py-3 text-sm">
              <Checkbox
                checked={newConsent}
                onCheckedChange={checked => setNewConsent(checked === true)}
                className="mt-0.5"
              />
              <span>
                Guardians of children in this camp consent to data usage for research purposes.
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                resetCreateForm();
                setCreateOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!campToDelete} onOpenChange={open => !open && setCampToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{campToDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the camp and its roster from this device. Recordings already captured are
              not deleted — they will still sync to the server — but their camp grouping on this
              device is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              Delete camp
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
