import { rolePermissions } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { PageSkeleton } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { assetQuery, invalidateLibrary } from '../library/api.ts';
import { librarySearchParamsSchema } from '../library/filters.ts';
import { CueEditorSection } from './cue-editor-section.tsx';
import { useCueEditorT } from './messages.ts';

// The cue editor page (#24): one track's cue points across the whole page, with a tall
// waveform. Opened from the asset drawer's cue summary (cue-summary.tsx). The library's
// filters ride along in the search params, so "back" returns to the same list, with the
// track's drawer open.

/** The library's search params, minus the open asset (it's in the path). */
export const cueEditorSearchSchema = librarySearchParamsSchema.omit({ asset: true });

const route = getRouteApi('/_app/stations/$stationId/library/$assetId/cues');

export function CueEditorPage() {
  const t = useCueEditorT();
  const { stationId, assetId } = route.useParams();
  const search = route.useSearch();
  const queryClient = useQueryClient();
  const station = findStation(useOrgs(), stationId)?.station;
  const canWrite = station ? rolePermissions[station.role].includes('library:write') : false;
  const detail = useQuery(assetQuery(stationId, assetId));
  const [dirty, setDirty] = useState(false);
  const { guard } = useUnsavedChanges(dirty);

  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="self-start"
      nativeButton={false}
      render={
        <Link
          to="/stations/$stationId/library"
          params={{ stationId }}
          search={{ ...search, asset: assetId }}
        />
      }
    >
      <ArrowLeftIcon data-icon="inline-start" />
      {t('page.back')}
    </Button>
  );

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError) {
    return (
      <div className="flex flex-col items-start gap-4 p-4 sm:p-6">
        {back}
        {isApiError(detail.error, 'not_found') ? (
          <p className="text-sm text-muted-foreground">{t('page.notFound')}</p>
        ) : (
          <FormAlert error={detail.error} />
        )}
      </div>
    );
  }
  const asset = detail.data;
  const subtitle = [asset.artists.join(', '), asset.album, asset.year].filter(Boolean).join(' · ');

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 text-sm sm:p-6">
      <header className="flex flex-col gap-1">
        {back}
        <h1 className="font-heading text-xl font-semibold">
          {asset.title}
          {asset.version && (
            <span className="font-normal text-muted-foreground"> ({asset.version})</span>
          )}
        </h1>
        {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
      </header>
      <CueEditorSection
        layout="page"
        stationId={stationId}
        asset={asset}
        canWrite={canWrite}
        refresh={() => invalidateLibrary(queryClient, stationId)}
        onDirtyChange={setDirty}
      />
      {guard}
    </div>
  );
}
