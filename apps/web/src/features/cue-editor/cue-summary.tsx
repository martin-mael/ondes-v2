import { Link, useSearch } from '@tanstack/react-router';
import { AudioWaveformIcon, LockIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { isApiError } from '../../app/api/client.ts';
import type { AssetDrawerSlotProps } from '../library/drawer-slots.ts';
import { formatSamples } from '../library/format.ts';
import { WaveformSkeleton } from './cue-editor-section.tsx';
import { useCueEditorT } from './messages.ts';
import { draftOf, fadeRegions, MARKER_COLORS, MARKER_FIELDS } from './model.ts';
import { fullView, sampleToX, useElementWidth, usePeaks, Waveform } from './waveform/index.ts';

// The asset drawer's cue section (#24): a small read-only waveform with the cue markers, the
// cue times, and a link to the cue editor page (cue-editor-page.tsx), where they're edited.

const SUMMARY_HEIGHT = 56;

const LIST_FIELDS = [
  'cueIn',
  'fadeIn',
  'introEnd',
  'outroStart',
  'crossStartNext',
  'fadeOut',
  'cueOut',
] as const;

export function CueSummary({ stationId, asset }: AssetDrawerSlotProps) {
  const t = useCueEditorT();
  const peaksFile = asset.files.find((f) => f.role === 'peaks');
  const peaks = usePeaks(stationId, asset.id, peaksFile?.sha256, peaksFile !== undefined);
  const cues = asset.cues;
  const draft = draftOf(cues);
  // The library's filters, carried to the page so its "back" returns to the same list.
  const librarySearch = useSearch({
    from: '/_app/stations/$stationId/library',
    shouldThrow: false,
  });
  const { asset: _open, ...search } = librarySearch ?? { asset: undefined };

  const waveformMissing = !peaksFile || (peaks.isError && isApiError(peaks.error, 'not_found'));
  return (
    <div className="flex flex-col gap-2">
      {waveformMissing ? null : peaks.isError ? (
        <p className="text-destructive">{t('peaks.error')}</p>
      ) : peaks.isPending ? (
        <WaveformSkeleton height={SUMMARY_HEIGHT} />
      ) : (
        <SummaryWaveform
          peaks={peaks.data}
          draft={draft}
          label={t('summary.waveform', { title: asset.title })}
          shortLabel={(field) => t(`short.${field}`)}
        />
      )}
      {cues ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 sm:grid-cols-[auto_1fr_auto_1fr]">
          {LIST_FIELDS.map((field) => {
            const point = cues[field];
            // Unset points have no marker on the waveform and no row here.
            if (point.samples === null) return null;
            return (
              <div key={field} className="contents" data-summary-field={field}>
                <dt className="text-muted-foreground">{t(`field.${field}`)}</dt>
                <dd className="flex items-center gap-1 tabular-nums">
                  {formatSamples(point.samples, cues.sampleRate)}
                  {point.locked && (
                    <LockIcon
                      className="size-3"
                      aria-label={t('point.locked', { field: t(`field.${field}`) })}
                    />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-muted-foreground">{t('summary.none')}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        nativeButton={false}
        render={
          <Link
            to="/stations/$stationId/library/$assetId/cues"
            params={{ stationId, assetId: asset.id }}
            search={search}
          />
        }
      >
        <AudioWaveformIcon data-icon="inline-start" />
        {t('summary.edit')}
      </Button>
    </div>
  );
}

function SummaryWaveform({
  peaks,
  draft,
  label,
  shortLabel,
}: {
  peaks: Parameters<typeof Waveform>[0]['peaks'];
  draft: ReturnType<typeof draftOf>;
  label: string;
  shortLabel: (field: (typeof MARKER_FIELDS)[number]) => string;
}) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const length = peaks.lengthSamples;
  const view = fullView(length);
  const x = (sample: number) => sampleToX(view, width, sample);
  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      className="relative overflow-hidden rounded-[4px] bg-muted/40"
      style={{ height: SUMMARY_HEIGHT }}
    >
      <Waveform
        peaks={peaks}
        fromSample={view.fromSample}
        toSample={view.toSample}
        height={SUMMARY_HEIGHT}
        className="absolute inset-0"
      />
      {width > 0 &&
        fadeRegions(draft, length).map((region) => (
          <div
            key={region.id}
            aria-hidden
            className="absolute inset-y-0 opacity-15"
            style={{
              left: x(region.fromSample),
              width: Math.max(0, x(region.toSample) - x(region.fromSample)),
              background: MARKER_COLORS[region.id === 'fadeIn' ? 'cueIn' : 'cueOut'],
            }}
          />
        ))}
      {width > 0 &&
        MARKER_FIELDS.map((field) => {
          const samples = draft[field].samples;
          if (samples === null) return null;
          return (
            <div
              key={field}
              aria-hidden
              data-summary-marker={field}
              className="absolute inset-y-0"
              style={{ left: Math.min(width - 1, Math.max(0, x(samples))) }}
            >
              <div
                className="absolute inset-y-0 w-px"
                style={{ background: MARKER_COLORS[field] }}
              />
              <div
                className="absolute top-0 rounded-r-[4px] px-0.5 text-[0.5625rem] leading-3 font-medium whitespace-nowrap text-white"
                style={{ background: MARKER_COLORS[field] }}
              >
                {shortLabel(field)}
              </div>
            </div>
          );
        })}
    </div>
  );
}
