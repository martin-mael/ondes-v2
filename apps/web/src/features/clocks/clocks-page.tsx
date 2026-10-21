import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { CopyIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { isApiError } from '../../app/api/client.ts';
import { FormAlert } from '../../app/forms.tsx';
import { ListSkeleton } from '../../app/pending.tsx';
import { clockKeys, clocksApi, clocksQuery } from './api.ts';
import { ClockTimeline } from './clock-timeline.tsx';
import { formatMs } from './format.ts';
import { useClockT } from './messages.ts';

const route = getRouteApi('/_app/stations/$stationId/clocks');

export function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full border border-border"
      style={{ backgroundColor: color ?? 'transparent' }}
    />
  );
}

export function ClocksPage() {
  const t = useClockT();
  const { stationId } = route.useParams();
  const list = useQuery(clocksQuery(stationId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const duplicate = async (id: string) => {
    try {
      const copy = await clocksApi.duplicate(stationId, id);
      await queryClient.invalidateQueries({ queryKey: clockKeys.all(stationId) });
      toast.success(t('duplicated'));
      await navigate({
        to: '/stations/$stationId/clocks/$clockId',
        params: { stationId, clockId: copy.id },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button
          className="ml-auto"
          nativeButton={false}
          render={<Link to="/stations/$stationId/clocks/new" params={{ stationId }} />}
        >
          <PlusIcon data-icon="inline-start" />
          {t('new')}
        </Button>
      </div>

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        isApiError(list.error, 'forbidden') ? (
          <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
        ) : (
          <FormAlert error={list.error} />
        )
      ) : list.data.items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.name')}</TableHead>
              <TableHead className="text-right">{t('col.length')}</TableHead>
              <TableHead className="text-right">{t('col.slots')}</TableHead>
              <TableHead className="w-1/3">{t('col.estimate')}</TableHead>
              <TableHead>{t('col.status')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((clock) => {
              const warnings = clock.estimate.warnings.length;
              return (
                <TableRow key={clock.id}>
                  <TableCell>
                    <Link
                      to="/stations/$stationId/clocks/$clockId"
                      params={{ stationId, clockId: clock.id }}
                      className="flex items-center gap-2 font-medium hover:underline"
                    >
                      <ColorDot color={clock.color} />
                      {clock.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMs(clock.targetDurationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{clock.slots.length}</TableCell>
                  <TableCell>
                    <ClockTimeline slots={clock.slots} estimate={clock.estimate} compact />
                  </TableCell>
                  <TableCell>
                    {warnings === 0 ? (
                      <Badge variant="outline">{t('status.ok')}</Badge>
                    ) : (
                      <Badge variant="destructive">
                        {warnings === 1
                          ? t('status.warning')
                          : t('status.warnings', { count: warnings })}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => duplicate(clock.id)}
                      aria-label={`${t('duplicate')} ${clock.name}`}
                    >
                      <CopyIcon data-icon="inline-start" />
                      {t('duplicate')}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
