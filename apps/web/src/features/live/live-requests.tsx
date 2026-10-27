import { type LiveRequest, rolePermissions } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useSseEvent } from '../../app/sse/sse.tsx';
import { invalidateLive, liveApi, liveKeys, requestsQuery } from './api.ts';
import { useLiveError, useLiveT } from './messages.ts';

// Ad-hoc live approval (#65, ADR 0033): "DJ X is connected, put on air?". A DJ whose streamer
// needs approval connected outside their slots and events; a member with `engine:control`
// puts them on air (a handover if another DJ is on) or refuses. Self-contained, so any page
// can mount it with the station id: the Live page does, and so does the on-air dashboard
// (#70). Renders nothing for members who can't decide, or when nobody is waiting. Kept fresh
// by the `live.request.*` events; no polling.

export function LiveRequestPrompt({ stationId }: { stationId: string }) {
  const found = findStation(useOrgs(), stationId);
  const canControl = !!found && rolePermissions[found.station.role].includes('engine:control');
  const queryClient = useQueryClient();
  const requests = useQuery({ ...requestsQuery(stationId), enabled: canControl });
  const refetch = () => queryClient.invalidateQueries({ queryKey: liveKeys.requests(stationId) });
  useSseEvent('live.request.created', refetch);
  useSseEvent('live.request.decided', refetch);

  const pending = requests.data?.requests ?? [];
  if (!canControl || pending.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-live="polite">
      {pending.map((r) => (
        <RequestCard
          key={r.id}
          stationId={stationId}
          request={r}
          timezone={found?.station.timezone ?? 'UTC'}
          onDone={() => invalidateLive(queryClient, stationId)}
        />
      ))}
    </section>
  );
}

function RequestCard({
  stationId,
  request,
  timezone,
  onDone,
}: {
  stationId: string;
  request: LiveRequest;
  timezone: string;
  onDone(): Promise<unknown>;
}) {
  const t = useLiveT();
  const liveError = useLiveError();
  const { locale } = useI18n();
  const [busy, setBusy] = useState<'approve' | 'refuse' | null>(null);
  const name = request.streamer.displayName;
  // Station time only (CLAUDE.md "Web app").
  const since = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: 'short' }).format(
    request.requestedAt,
  );

  const act = async (action: 'approve' | 'refuse') => {
    setBusy(action);
    try {
      if (action === 'approve') {
        await liveApi.approve(stationId, request.id);
        toast.success(t('requests.approved', { name }));
      } else {
        await liveApi.refuse(stationId, request.id);
        toast.success(t('requests.refused', { name }));
      }
    } catch (error) {
      toast.error(liveError(error));
    } finally {
      setBusy(null);
      await onDone();
    }
  };

  return (
    <Card size="sm" className="relative overflow-hidden rounded-[4px]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" />
      <CardContent className="flex flex-wrap items-center gap-3 pl-5">
        <RadioIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {t('requests.prompt', { name, input: request.input })}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('requests.since', { time: since })}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => act('approve')}>
            <DelayedSpinner when={busy === 'approve'} data-icon="inline-start" />
            {t('requests.approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => act('refuse')}
          >
            <DelayedSpinner when={busy === 'refuse'} data-icon="inline-start" />
            {t('requests.refuse')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
