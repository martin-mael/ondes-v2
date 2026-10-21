import {
  type FallbackAsset,
  type FallbackCacheState,
  rolePermissions,
  type SafetyStatus,
  type TagKey,
  tagKeySchema,
} from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { LifeBuoyIcon, PlusIcon, TagIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { isApiError } from '../../../app/api/client.ts';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { FormAlert, useErrorMessage } from '../../../app/forms.tsx';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import { useSseEvent } from '../../../app/sse/sse.tsx';
import { safetyApi, safetyQuery, type UploadProgress, uploadToLibrary } from './api.ts';
import { AssetPicker } from './asset-picker.tsx';
import { formatDuration } from './format.ts';
import { type SafetyMessageKey, useSafetyT } from './messages.ts';

// Station settings: safety playlist and emergency file (#34). Shows what the engine's cache
// holds (the worker syncs it), and whether the station is in safety mode right now.

/** While something is still syncing, refresh this often. */
const PENDING_REFRESH_MS = 10_000;

export function SafetyPage() {
  const t = useSafetyT();
  const { stationId } = useParams({ from: '/_app/stations/$stationId/settings/safety' });
  const station = findStation(useOrgs(), stationId)?.station;
  const canEdit = station ? rolePermissions[station.role].includes('engine:control') : false;
  const queryClient = useQueryClient();
  const query = useQuery({
    ...safetyQuery(stationId),
    refetchInterval: (q) => (hasPending(q.state.data) ? PENDING_REFRESH_MS : false),
  });
  // Safety mode starts and ends with what goes on air.
  useSseEvent('engine.track.started', () => {
    void queryClient.invalidateQueries({ queryKey: safetyQuery(stationId).queryKey });
  });
  const setData = (data: SafetyStatus) =>
    queryClient.setQueryData(safetyQuery(stationId).queryKey, data);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
          {query.data && <OnAirBadge status={query.data} />}
        </div>
        <p className="max-w-2xl text-muted-foreground">{t('description')}</p>
        {query.data && <SyncedAt at={query.data.syncedAt} />}
        {!canEdit && <p className="text-muted-foreground">{t('readOnly')}</p>}
      </div>
      {query.isError && <FormAlert error={query.error} />}
      {query.isPending ? (
        <Skeleton className="h-48" />
      ) : query.data ? (
        <>
          <EmergencyCard
            stationId={stationId}
            status={query.data}
            canEdit={canEdit}
            onChange={setData}
          />
          <SafetyCard
            stationId={stationId}
            status={query.data}
            canEdit={canEdit}
            onChange={setData}
          />
        </>
      ) : null}
    </div>
  );
}

function hasPending(status: SafetyStatus | undefined): boolean {
  if (!status) return false;
  const all = [...status.safety.assets, ...(status.emergency ? [status.emergency] : [])];
  return all.some((a) => a.cache.state === 'pending' || a.cache.state === 'no_file');
}

function OnAirBadge({ status }: { status: SafetyStatus }) {
  const t = useSafetyT();
  const { locale } = useI18n();
  const source = status.onAir?.source;
  if (source !== 'safety' && source !== 'emergency') {
    return status.onAir ? <Badge variant="outline">{t('onAir.normal')}</Badge> : null;
  }
  const since = status.onAir?.startedAt.toLocaleTimeString(locale, { hour12: false }) ?? '';
  return (
    <Badge variant="destructive" data-testid="safety-mode">
      <LifeBuoyIcon />
      {t(source === 'emergency' ? 'onAir.emergency' : 'onAir.safety')}{' '}
      {t('onAir.since', { time: since })}
    </Badge>
  );
}

function SyncedAt({ at }: { at: Date | null }) {
  const t = useSafetyT();
  const { locale } = useI18n();
  return (
    <p className="text-muted-foreground">
      {at
        ? t('syncedAt', { time: at.toLocaleString(locale, { hour12: false }) })
        : t('neverSynced')}
    </p>
  );
}

const STATE_VARIANT: Record<
  FallbackCacheState,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  ready: 'default',
  pending: 'secondary',
  failed: 'destructive',
  no_file: 'outline',
};

function CacheBadge({ asset }: { asset: FallbackAsset }) {
  const t = useSafetyT();
  return (
    <Badge
      variant={STATE_VARIANT[asset.cache.state]}
      title={asset.cache.errorMessage ?? asset.cache.error ?? undefined}
    >
      {t(`state.${asset.cache.state}` as SafetyMessageKey)}
    </Badge>
  );
}

type CardProps = {
  stationId: string;
  status: SafetyStatus;
  canEdit: boolean;
  onChange(status: SafetyStatus): void;
};

function useSafetyError() {
  const t = useSafetyT();
  const message = useErrorMessage();
  return (error: unknown) =>
    isApiError(error, 'safety_playlist_full') ? t('error.safety_playlist_full') : message(error);
}

function EmergencyCard({ stationId, status, canEdit, onChange }: CardProps) {
  const t = useSafetyT();
  const errorMessage = useSafetyError();
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState<{ name: string; p: UploadProgress } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = useMutation({
    mutationFn: (assetId: string | null) => safetyApi.setEmergency(stationId, { assetId }),
    onSuccess: (data) => {
      onChange(data);
      setPicking(false);
      toast.success(t('emergency.set'));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress({ name: file.name, p: { phase: 'uploading', pct: 0 } });
      return uploadToLibrary(stationId, file, (p) => setProgress({ name: file.name, p }));
    },
    onSuccess: (assetId) => set.mutate(assetId),
    onError: (error) => toast.error(t('emergency.uploadFailed', { reason: errorMessage(error) })),
    onSettled: () => setProgress(null),
  });

  const emergency = status.emergency;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('emergency.title')}</CardTitle>
        <CardDescription>{t('emergency.description')}</CardDescription>
        {canEdit && (
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPicking(true)} disabled={upload.isPending}>
              {t('emergency.choose')}
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={upload.isPending}
            >
              <UploadIcon />
              {t('emergency.upload')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              className="hidden"
              data-testid="emergency-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload.mutate(file);
              }}
            />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {emergency ? (
          <div className="flex items-center gap-3" data-testid="emergency-asset">
            <span className="flex-1 truncate font-medium">
              {[emergency.title, emergency.artists.join(', ')].filter(Boolean).join(' · ')}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatDuration(emergency.durationMs)}
            </span>
            <CacheBadge asset={emergency} />
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                disabled={set.isPending}
                onClick={() => set.mutate(null)}
              >
                {t('emergency.clear')}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">{t('emergency.none')}</p>
        )}
        {progress && (
          <p role="status" className="text-muted-foreground">
            {progress.p.phase === 'uploading'
              ? t('emergency.uploading', { name: progress.name, pct: progress.p.pct })
              : t('emergency.processing', { name: progress.name })}
          </p>
        )}
      </CardContent>
      <AssetPicker
        stationId={stationId}
        open={picking}
        onOpenChange={setPicking}
        mode="single"
        exclude={emergency ? [emergency.assetId] : []}
        pending={set.isPending}
        onPick={([assetId]) => assetId && set.mutate(assetId)}
      />
    </Card>
  );
}

function SafetyCard({ stationId, status, canEdit, onChange }: CardProps) {
  const t = useSafetyT();
  const errorMessage = useSafetyError();
  const [picking, setPicking] = useState(false);
  const [tagging, setTagging] = useState(false);
  const { assets, readyCount, readyDurationMs } = status.safety;

  const add = useMutation({
    mutationFn: (body: Parameters<typeof safetyApi.addAssets>[1]) =>
      safetyApi.addAssets(stationId, body),
    onSuccess: (data) => {
      toast.success(
        t('safety.added', { count: data.safety.assets.length - status.safety.assets.length }),
      );
      onChange(data);
      setPicking(false);
      setTagging(false);
    },
    // The tag dialog shows its own error.
    onError: (error) => !tagging && toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (assetId: string) => safetyApi.removeAsset(stationId, assetId),
    onSuccess: (_, assetId) =>
      onChange({
        ...status,
        safety: recount(status.safety.assets.filter((a) => a.assetId !== assetId)),
      }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('safety.title')}</CardTitle>
        <CardDescription>{t('safety.description')}</CardDescription>
        {canEdit && (
          <CardAction className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPicking(true)}>
              <PlusIcon />
              {t('safety.add')}
            </Button>
            <Button variant="outline" onClick={() => setTagging(true)}>
              <TagIcon />
              {t('safety.addByTag')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {assets.length === 0 ? (
          <p className="text-muted-foreground">{t('safety.empty')}</p>
        ) : (
          <>
            <p className="text-muted-foreground" data-testid="safety-summary">
              {t('safety.summary', {
                ready: readyCount,
                total: assets.length,
                duration: formatDuration(readyDurationMs),
              })}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.title')}</TableHead>
                  <TableHead className="text-right">{t('col.duration')}</TableHead>
                  <TableHead>{t('col.status')}</TableHead>
                  {canEdit && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <TableRow key={a.assetId}>
                    <TableCell className="max-w-0 truncate">
                      {[a.title, a.artists.join(', ')].filter(Boolean).join(' · ')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(a.durationMs)}
                    </TableCell>
                    <TableCell>
                      <CacheBadge asset={a} />
                    </TableCell>
                    {canEdit && (
                      <TableCell className="w-0">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('safety.remove', { title: a.title })}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(a.assetId)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
      <AssetPicker
        stationId={stationId}
        open={picking}
        onOpenChange={setPicking}
        mode="multiple"
        exclude={assets.map((a) => a.assetId)}
        pending={add.isPending}
        onPick={(assetIds) => add.mutate({ assetIds })}
      />
      <TagDialog
        open={tagging}
        onOpenChange={setTagging}
        pending={add.isPending}
        error={add.error}
        onSubmit={(tag) => add.mutate({ tag })}
      />
    </Card>
  );
}

function recount(assets: FallbackAsset[]): SafetyStatus['safety'] {
  const ready = assets.filter((a) => a.cache.state === 'ready');
  return {
    assets,
    readyCount: ready.length,
    readyDurationMs: ready.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
  };
}

function TagDialog({
  open,
  onOpenChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  pending: boolean;
  error: unknown;
  onSubmit(tag: { key: TagKey; value: string }): void;
}) {
  const t = useSafetyT();
  const errorMessage = useSafetyError();
  const [key, setKey] = useState<TagKey>('genre');
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit({ key, value: value.trim() });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('tag.title')}</DialogTitle>
            <DialogDescription>{t('tag.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="safety-tag-key">{t('tag.key')}</Label>
              <Select value={key} onValueChange={(v) => v && setKey(v)}>
                <SelectTrigger id="safety-tag-key" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tagKeySchema.options.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="safety-tag-value">{t('tag.value')}</Label>
              <Input
                id="safety-tag-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={200}
                required
              />
            </div>
          </div>
          {Boolean(error) && <p className="text-destructive">{errorMessage(error)}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending || !value.trim()}>
              {t('tag.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
