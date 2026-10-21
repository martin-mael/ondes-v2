import { type AssetType, assetTypeSchema } from '@ondes/shared';
import { RotateCcwIcon, UploadIcon, XIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Progress } from '@/ui/progress';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { formatBytes } from './format.ts';
import { type LibraryT, useLibraryT } from './messages.ts';
import {
  cancelUpload,
  clearFinished,
  isFinal,
  retryUpload,
  startUploads,
  type UploadJob,
  useUploads,
} from './uploads.ts';

// Upload panel (#23): drop zone or file picker, then one row per file with its byte progress
// while sending and its ingest status (from `upload.updated` events) afterwards.

export function UploadPanel({
  stationId,
  onOpenAsset,
  onClose,
}: {
  stationId: string;
  onOpenAsset: (assetId: string) => void;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const jobs = useUploads(stationId);
  const [assetType, setAssetType] = useState<AssetType>('song');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const typeId = useId();
  const add = (files: FileList | null) => {
    if (files && files.length > 0) startUploads(stationId, [...files], assetType);
  };

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{t('upload.title')}</h2>
          <div className="ml-auto flex items-center gap-2">
            <Label htmlFor={typeId} className="font-normal text-muted-foreground">
              {t('upload.assetType')}
            </Label>
            <NativeSelect
              id={typeId}
              size="sm"
              value={assetType}
              onChange={(e) => setAssetType(e.target.value as AssetType)}
            >
              {assetTypeSchema.options.map((type) => (
                <NativeSelectOption key={type} value={type}>
                  {t(`type.${type}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {jobs.some(isFinal) && (
              <Button variant="ghost" size="sm" onClick={() => clearFinished(stationId)}>
                {t('upload.clear')}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label={t('upload.close')} onClick={onClose}>
              <XIcon />
            </Button>
          </div>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard path. */}
        <div
          data-dragging={dragging || undefined}
          className="flex flex-col items-center gap-2 rounded-md border border-dashed p-4 text-muted-foreground data-dragging:border-primary data-dragging:bg-primary/5"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
        >
          <p>{t('upload.drop')}</p>
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
            <UploadIcon data-icon="inline-start" />
            {t('upload.choose')}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept="audio/*,.flac,.wav,.aiff,.aif,.mp3,.m4a,.ogg,.opus"
            className="hidden"
            data-testid="upload-input"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {jobs.length > 0 && (
          <ul
            className="flex max-h-60 flex-col gap-2 overflow-y-auto"
            aria-label={t('upload.title')}
          >
            {jobs.map((job) => (
              <UploadRow
                key={job.key}
                job={job}
                t={t}
                onCancel={() => void cancelUpload(stationId, job.key)}
                onRetry={() => void retryUpload(stationId, job.key)}
                onOpen={onOpenAsset}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function statusLabel(t: LibraryT, job: UploadJob): string {
  if (job.status === 'sending') {
    const percent = job.sizeBytes > 0 ? Math.floor((job.sentBytes / job.sizeBytes) * 100) : 100;
    return t('upload.status.sending', { percent });
  }
  const status = t(`upload.status.${job.status}`);
  return job.errorCode ? `${status}: ${t(`upload.error.${job.errorCode}`)}` : status;
}

function UploadRow({
  job,
  t,
  onCancel,
  onRetry,
  onOpen,
}: {
  job: UploadJob;
  t: LibraryT;
  onCancel: () => void;
  onRetry: () => void;
  onOpen: (assetId: string) => void;
}) {
  const { locale } = useI18n();
  const target = job.assetId ?? job.duplicateOfAssetId;
  const failed = job.status === 'failed' || job.status === 'quarantined';
  return (
    <li className="flex flex-col gap-1" aria-label={job.filename}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium" title={job.filename}>
          {job.filename}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {formatBytes(job.sizeBytes, locale)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          role="status"
          className={`min-w-0 flex-1 truncate ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
          title={job.error ?? undefined}
        >
          {statusLabel(t, job)}
        </span>
        {target && (job.status === 'ingested' || job.status === 'duplicate') && (
          <Button variant="link" size="xs" onClick={() => onOpen(target)}>
            {t('upload.open')}
          </Button>
        )}
        {job.status === 'failed' && job.errorCode !== 'network' && job.uploadId && (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            <RotateCcwIcon data-icon="inline-start" />
            {t('upload.retry')}
          </Button>
        )}
        {!isFinal(job) && (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            {t('upload.cancel')}
          </Button>
        )}
      </div>
      {(job.status === 'sending' || job.status === 'preparing') && (
        <Progress value={job.sizeBytes > 0 ? (job.sentBytes / job.sizeBytes) * 100 : 0} />
      )}
      {(job.status === 'queued' || job.status === 'processing') && <Progress value={null} />}
    </li>
  );
}
