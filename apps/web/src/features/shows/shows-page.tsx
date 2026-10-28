import type { Show } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { isApiError } from '../../app/api/client.ts';
import { FormAlert } from '../../app/forms.tsx';
import { PageHeader } from '../../app/page-header.tsx';
import { ListSkeleton } from '../../app/pending.tsx';
import { useShowAccess } from './access.ts';
import { showsQuery } from './api.ts';
import { useShowT } from './messages.ts';
import { ShowFormDialog } from './show-form.tsx';

const route = getRouteApi('/_app/stations/$stationId/shows');

/** The show's artwork, or its initials on its colour. */
export function ShowArtwork({
  show,
  className = 'size-14',
}: {
  show: Pick<Show, 'name' | 'artworkUrl' | 'colour'>;
  className?: string;
}) {
  if (show.artworkUrl) {
    return (
      <img
        src={show.artworkUrl}
        alt=""
        className={`${className} shrink-0 rounded-md object-cover`}
        loading="lazy"
      />
    );
  }
  const initials = show.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-md bg-muted font-heading font-semibold text-muted-foreground`}
      style={show.colour ? { backgroundColor: show.colour, color: 'white' } : undefined}
    >
      {initials}
    </span>
  );
}

function ShowCard({ stationId, show }: { stationId: string; show: Show }) {
  const t = useShowT();
  return (
    <Link
      to="/stations/$stationId/shows/$showId"
      params={{ stationId, showId: show.id }}
      className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-foreground/10 transition-colors hover:bg-muted"
    >
      <ShowArtwork show={show} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">{show.name}</span>
        <span className="truncate text-muted-foreground">
          {show.hosts.length > 0 ? show.hosts.map((h) => h.name).join(', ') : t('list.noHosts')}
        </span>
        <span>
          <Badge variant="outline">{t(`type.${show.defaultSlotType}`)}</Badge>
        </span>
      </div>
    </Link>
  );
}

export function ShowsPage() {
  const t = useShowT();
  const { stationId } = route.useParams();
  const navigate = useNavigate();
  const access = useShowAccess(stationId);
  const list = useQuery(showsQuery(stationId));
  const [creating, setCreating] = useState(false);

  const items = list.data?.items ?? [];
  const mine = items.filter((s) => s.hosts.some((h) => h.userId === access.userId));
  const others = mine.length > 0 ? items.filter((s) => !mine.includes(s)) : items;

  return (
    <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          access.canManage && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon data-icon="inline-start" />
              {t('list.new')}
            </Button>
          )
        }
      />

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        isApiError(list.error, 'forbidden') ? (
          <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
        ) : (
          <FormAlert error={list.error} />
        )
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('list.empty')}
          </CardContent>
        </Card>
      ) : (
        <>
          {mine.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-heading font-semibold">{t('list.mine')}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {mine.map((show) => (
                  <ShowCard key={show.id} stationId={stationId} show={show} />
                ))}
              </div>
            </section>
          )}
          {others.length > 0 && (
            <section className="flex flex-col gap-3">
              {mine.length > 0 && (
                <h2 className="font-heading font-semibold">{t('list.others')}</h2>
              )}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {others.map((show) => (
                  <ShowCard key={show.id} stationId={stationId} show={show} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <ShowFormDialog
        stationId={stationId}
        open={creating}
        onOpenChange={setCreating}
        canManage={access.canManage}
        onSaved={(show) =>
          navigate({
            to: '/stations/$stationId/shows/$showId',
            params: { stationId, showId: show.id },
          })
        }
      />
    </div>
  );
}
