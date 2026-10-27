import type { Promo } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { ListSkeleton } from '../../app/pending.tsx';
import { promoPlaysQuery } from './api.ts';
import { usePromoT } from './messages.ts';

// A promo's plays (#60): aired per day, then every play, planned (the generator's placements,
// with why a dropped one won't air) and aired (the as-run), in station time. A placed play opens
// its transition in the segue editor; one still being placed links to its day in the log.

export function PlaysDialog({
  stationId,
  timezone,
  promo,
  onClose,
}: {
  stationId: string;
  timezone: string;
  promo: Promo | null;
  onClose(): void;
}) {
  const t = usePromoT();
  const { locale } = useI18n();
  const plays = useQuery({
    ...promoPlaysQuery(stationId, promo?.id ?? ''),
    enabled: promo !== null,
  });
  const time = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  const day = (date: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
    }).format(new Date(`${date}T12:00:00Z`));
  const data = plays.data;
  const max = Math.max(1, ...(data?.airedByDay.map((d) => d.count) ?? []));

  return (
    <Dialog open={promo !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('plays.title', { title: promo?.title ?? '' })}</DialogTitle>
          <DialogDescription>{t('plays.description')}</DialogDescription>
        </DialogHeader>
        {plays.isPending ? (
          <ListSkeleton rows={5} />
        ) : plays.isError ? (
          <FormAlert error={plays.error} />
        ) : (
          data && (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('plays.byDay')}</h3>
                <ol className="flex items-end gap-1" aria-label={t('plays.byDay')}>
                  {data.airedByDay.map((d) => (
                    <li
                      key={d.date}
                      className="flex flex-1 flex-col items-center gap-1 text-xs text-muted-foreground"
                      title={`${day(d.date)}: ${d.count}`}
                    >
                      <span className="tabular-nums">{d.count}</span>
                      <span
                        className="w-full rounded-sm bg-primary/70"
                        style={{ height: `${Math.max(2, (d.count / max) * 48)}px` }}
                      />
                      <span className="whitespace-nowrap">{day(d.date)}</span>
                    </li>
                  ))}
                </ol>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('plays.list')}</h3>
                {data.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('plays.empty')}</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.items.map((p) => (
                      <li
                        key={p.placementId ?? p.asRunEntryId ?? p.playedAt.toISOString()}
                        className="flex flex-wrap items-center gap-2 py-2"
                      >
                        <span className="tabular-nums">{time(p.playedAt)}</span>
                        {p.kind === 'aired' ? (
                          <Badge variant="secondary">{t('plays.aired')}</Badge>
                        ) : (
                          <Badge variant={p.placementStatus === 'dropped' ? 'outline' : 'default'}>
                            {p.placementStatus === 'dropped'
                              ? t('plays.dropped')
                              : p.placementStatus === 'pending'
                                ? t('plays.pending')
                                : t('plays.placed')}
                          </Badge>
                        )}
                        {p.detail && <span className="text-muted-foreground">{p.detail}</span>}
                        {p.kind === 'planned' &&
                        p.placementStatus === 'placed' &&
                        p.fromItemId &&
                        p.toItemId ? (
                          <Link
                            className="ml-auto text-primary underline-offset-4 hover:underline"
                            to="/stations/$stationId/log/segue"
                            params={{ stationId }}
                            search={{ date: p.localDate, from: p.fromItemId, to: p.toItemId }}
                          >
                            {t('plays.openSegue')}
                          </Link>
                        ) : (
                          p.kind === 'planned' &&
                          p.placementStatus !== 'dropped' && (
                            <Link
                              className="ml-auto text-primary underline-offset-4 hover:underline"
                              to="/stations/$stationId/log"
                              params={{ stationId }}
                              search={{ date: p.localDate }}
                            >
                              {t('plays.openLog')}
                            </Link>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
