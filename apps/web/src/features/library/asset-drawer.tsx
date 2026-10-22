import { type AssetActivity, type AssetDetail, CUE_FIELDS, type Permission } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CircleDashedIcon, LockIcon } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { ListSkeleton } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { activityQuery, assetQuery, invalidateLibrary } from './api.ts';
import {
  type AssetDrawerSectionId,
  type AssetDrawerSlot,
  type AssetDrawerSlotProps,
  assetDrawerSlots,
  type DrawerEntry,
  drawerLayout,
} from './drawer-slots.ts';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDb,
  formatDuration,
  formatSamples,
} from './format.ts';
import { type LibraryT, useLibraryT } from './messages.ts';

// The asset drawer (#23): everything stored about one asset, read-only, plus the sections
// other features plug in through drawer-slots.ts (the cue editor, #24).

export function AssetDrawer({
  stationId,
  assetId,
  allowed,
  onClose,
}: {
  stationId: string;
  assetId: string | undefined;
  allowed: (permission: Permission) => boolean;
  onClose: () => void;
}) {
  const t = useLibraryT();
  // Sections with unsaved edits (the cue editor's): closing the drawer asks first.
  const [dirtySlots, setDirtySlots] = useState<ReadonlySet<string>>(new Set());
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(dirtySlots.size > 0);
  const onDirtyChange = useCallback((slotId: string, dirty: boolean) => {
    setDirtySlots((current) => {
      if (current.has(slotId) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(slotId);
      else next.delete(slotId);
      return next;
    });
  }, []);
  return (
    <>
      <Sheet
        open={assetId !== undefined}
        onOpenChange={(open) =>
          !open &&
          confirmDiscard(() => {
            // Closing navigates (drops `?asset=`): past the guard once the person chose to.
            allowLeave();
            onClose();
          })
        }
      >
        <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-xl">
          {assetId && (
            <DrawerBody
              stationId={stationId}
              assetId={assetId}
              allowed={allowed}
              onDirtyChange={onDirtyChange}
              t={t}
            />
          )}
        </SheetContent>
      </Sheet>
      {guard}
    </>
  );
}

function DrawerBody({
  stationId,
  assetId,
  allowed,
  onDirtyChange,
  t,
}: {
  stationId: string;
  assetId: string;
  allowed: (permission: Permission) => boolean;
  onDirtyChange: (slotId: string, dirty: boolean) => void;
  t: LibraryT;
}) {
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const detail = useQuery(assetQuery(stationId, assetId));
  const activity = useQuery(activityQuery(stationId, assetId));

  if (detail.isPending) {
    return (
      <div className="p-6">
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        <ListSkeleton rows={8} />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="p-6">
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        <FormAlert error={detail.error} />
      </div>
    );
  }
  const asset = detail.data;
  const refresh = () => invalidateLibrary(queryClient, stationId);
  const entries = drawerLayout(assetDrawerSlots(), allowed);

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{t(`type.${asset.type}`)}</Badge>
          {asset.explicit && <Badge variant="secondary">E</Badge>}
        </div>
        <SheetTitle className="text-base">
          {asset.title}
          {asset.version && (
            <span className="font-normal text-muted-foreground"> ({asset.version})</span>
          )}
        </SheetTitle>
        <SheetDescription>
          {[asset.artists.join(', '), asset.album, asset.year].filter(Boolean).join(' · ') ||
            t('drawer.none')}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-5 p-4">
        {entries.map((entry) => (
          <DrawerSection
            key={entry.kind === 'slot' ? `slot:${entry.slot.id}` : entry.id}
            entry={entry}
            title={entry.kind === 'slot' ? entry.slot.title[locale] : t(`drawer.${entry.id}`)}
          >
            {entry.kind === 'slot' ? (
              <SlotSection
                slot={entry.slot}
                stationId={stationId}
                asset={asset}
                canWrite={allowed('library:write')}
                refresh={refresh}
                onDirtyChange={onDirtyChange}
              />
            ) : (
              <BuiltinSection id={entry.id} asset={asset} activity={activity.data} t={t} />
            )}
          </DrawerSection>
        ))}
      </div>
    </>
  );
}

function SlotSection({
  slot,
  onDirtyChange,
  ...props
}: Omit<AssetDrawerSlotProps, 'onDirtyChange'> & {
  slot: AssetDrawerSlot;
  onDirtyChange: (slotId: string, dirty: boolean) => void;
}) {
  const report = useCallback(
    (dirty: boolean) => onDirtyChange(slot.id, dirty),
    [onDirtyChange, slot.id],
  );
  return <slot.Component {...props} onDirtyChange={report} />;
}

function DrawerSection({
  entry,
  title,
  children,
}: {
  entry: DrawerEntry;
  title: string;
  children: ReactNode;
}) {
  const id = entry.kind === 'slot' ? `slot-${entry.slot.id}` : entry.id;
  return (
    <section aria-labelledby={`drawer-${id}`} className="flex flex-col gap-2">
      <h3 id={`drawer-${id}`} className="text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children}
      <Separator className="mt-2" />
    </section>
  );
}

function Rows({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BuiltinSection({
  id,
  asset,
  activity,
  t,
}: {
  id: AssetDrawerSectionId;
  asset: AssetDetail;
  activity: AssetActivity | undefined;
  t: LibraryT;
}) {
  const { locale } = useI18n();
  const none = t('drawer.none');
  switch (id) {
    case 'metadata': {
      const extra = Object.entries(asset.metadata).filter(
        ([, v]) => typeof v === 'string' && v.length > 0,
      ) as [string, string][];
      return (
        <Rows
          rows={[
            [t('field.album'), asset.album ?? none],
            [t('field.year'), asset.year ?? none],
            [t('col.duration'), formatDuration(asset.durationMs) || none],
            [t('field.isrc'), asset.isrc ?? none],
            [t('field.explicit'), asset.explicit ? t('bulk.edit.yes') : t('bulk.edit.no')],
            [t('field.startAt'), formatDateTime(asset.startAt, locale) || none],
            [t('field.killAt'), formatDateTime(asset.killAt, locale) || none],
            [t('field.sourceFilename'), asset.sourceFilename ?? none],
            [t('field.createdAt'), formatDateTime(asset.createdAt, locale)],
            [t('field.updatedAt'), formatDateTime(asset.updatedAt, locale)],
            ...extra.map(([k, v]): [string, ReactNode] => [k, v]),
            ...(asset.notes ? [[t('field.notes'), asset.notes] as [string, ReactNode]] : []),
          ]}
        />
      );
    }
    case 'tags':
      return asset.tags.length === 0 ? (
        <p className="text-muted-foreground">{t('bulk.tags.none')}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {asset.tags.map((tag) => (
            <Badge key={tag.id} variant="secondary">
              <span className="text-muted-foreground">{t(`tagKey.${tag.key}`)}:</span>
              {tag.value}
            </Badge>
          ))}
        </div>
      );
    case 'loudness': {
      const gain = asset.playoutGain;
      const gainLabel = `${formatDb(gain.gainDb)} (${t(`drawer.gain.${gain.source}`)}${
        gain.limitedByPeak ? `, ${t('drawer.gain.limited')}` : ''
      })`;
      return (
        <Rows
          rows={[
            [
              t('drawer.lufs'),
              asset.loudness
                ? formatDb(asset.loudness.integratedLufs, 'LUFS')
                : t('drawer.unmeasured'),
            ],
            [t('drawer.lra'), formatDb(asset.loudness?.loudnessRangeLu, 'LU') || none],
            [t('drawer.truePeak'), formatDb(asset.loudness?.truePeakDbtp, 'dBTP') || none],
            [t('drawer.gain'), gainLabel],
            [
              t('field.normalizeLoudness'),
              asset.normalizeLoudness ? t('bulk.edit.yes') : t('bulk.edit.no'),
            ],
            [t('field.gainOverrideDb'), formatDb(asset.gainOverrideDb) || none],
          ]}
        />
      );
    }
    case 'cues': {
      const cues = asset.cues;
      if (!cues) return <p className="text-muted-foreground">{t('drawer.cues.none')}</p>;
      return (
        <div className="flex flex-col gap-1">
          <Rows
            rows={CUE_FIELDS.map((field): [string, ReactNode] => {
              const point = cues[field];
              return [
                t(`drawer.cue.${field}`),
                point.samples === null ? (
                  none
                ) : (
                  <span key={field} className="flex items-center gap-2 tabular-nums">
                    {formatSamples(point.samples, cues.sampleRate)}
                    <span className="text-muted-foreground">{t(`drawer.cue.${point.source}`)}</span>
                    {point.locked && (
                      <LockIcon className="size-3" aria-label={t('drawer.cue.locked')} />
                    )}
                  </span>
                ),
              ];
            })}
          />
          {cues.analyzerVersion && (
            <p className="text-muted-foreground">
              {t('drawer.cue.analyzer', { version: cues.analyzerVersion })}
            </p>
          )}
        </div>
      );
    }
    case 'analysis': {
      const done = (ok: boolean) => (
        <span className="flex items-center gap-1">
          {ok ? <CheckIcon className="size-3" /> : <CircleDashedIcon className="size-3" />}
          {ok ? t('drawer.analysis.done') : t('drawer.analysis.missing')}
        </span>
      );
      const hasPeaks = asset.files.some((f) => f.role === 'peaks');
      return (
        <Rows
          rows={[
            [t('drawer.analysis.loudness'), done(asset.loudness !== null)],
            [t('drawer.analysis.cues'), done(asset.cues !== null)],
            [t('drawer.analysis.peaks'), done(hasPeaks)],
            [t('drawer.analysis.bpm'), asset.analysis?.bpm?.toFixed(1) ?? none],
            [t('drawer.analysis.key'), asset.analysis?.musicalKey ?? none],
            [
              t('drawer.analysis.energy'),
              asset.analysis?.energy === null || asset.analysis?.energy === undefined
                ? none
                : asset.analysis.energy.toFixed(2),
            ],
          ]}
        />
      );
    }
    case 'files':
      return asset.files.length === 0 ? (
        <p className="text-muted-foreground">{none}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {asset.files.map((file) => (
            <li key={file.id} className="flex flex-col">
              <span className="font-medium">
                {t(`drawer.file.${file.role}`)}{' '}
                <span className="font-normal text-muted-foreground">
                  {formatBytes(file.sizeBytes, locale)}
                </span>
              </span>
              <span className="text-muted-foreground">
                {file.sampleRate && file.channels
                  ? t('drawer.file.format', {
                      codec: file.codec,
                      rate: file.sampleRate,
                      channels: file.channels,
                    })
                  : file.codec}
                {file.durationSamples && file.sampleRate
                  ? ` · ${formatDuration((file.durationSamples / file.sampleRate) * 1000)}`
                  : ''}
              </span>
              <code className="truncate text-[0.625rem] text-muted-foreground" title={file.sha256}>
                {file.sha256}
              </code>
            </li>
          ))}
        </ul>
      );
    case 'activity':
      if (!activity) return <ListSkeleton rows={4} />;
      return (
        <Rows
          rows={[
            [
              t('drawer.lastPlayed'),
              activity.lastPlayedAt ? formatDateTime(activity.lastPlayedAt, locale) : t('never'),
            ],
            [t('drawer.plays'), `${activity.plays7d} / ${activity.plays30d}`],
            [
              t('drawer.cache'),
              !activity.cache
                ? t('drawer.cache.missing')
                : activity.cache.state === 'ready'
                  ? `${t('drawer.cache.ready')} (${formatDate(activity.cache.fetchedAt, locale)})`
                  : t('drawer.cache.failed', { error: activity.cache.error ?? '' }),
            ],
          ]}
        />
      );
    default:
      throw new Error(`unknown drawer section ${JSON.stringify(id satisfies never)}`);
  }
}
