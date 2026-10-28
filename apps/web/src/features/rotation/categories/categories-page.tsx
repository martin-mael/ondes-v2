import type { CategoryListItem } from '@ondes/shared';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { isApiError } from '../../../app/api/client.ts';
import { FormAlert } from '../../../app/forms.tsx';
import { PageHeader } from '../../../app/page-header.tsx';
import { ListSkeleton } from '../../../app/pending.tsx';
import { categoriesQuery } from './api.ts';
import { type CategoryT, useCategoryT } from './messages.ts';

const route = getRouteApi('/_app/stations/$stationId/categories');

function membershipLabel(t: CategoryT, category: CategoryListItem) {
  if (category.rule && category.counts.manualOnly + category.counts.excluded > 0) {
    return t('membership.both');
  }
  return category.rule ? t('membership.smart') : t('membership.manual');
}

export function CategoryColor({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full border border-border"
      style={{ backgroundColor: color ?? 'transparent' }}
    />
  );
}

export function CategoriesPage() {
  const t = useCategoryT();
  const { stationId } = route.useParams();
  const list = useQuery(categoriesQuery(stationId));

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button
            nativeButton={false}
            render={<Link to="/stations/$stationId/categories/new" params={{ stationId }} />}
          >
            <PlusIcon data-icon="inline-start" />
            {t('new')}
          </Button>
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
              <TableHead>{t('col.type')}</TableHead>
              <TableHead>{t('col.membership')}</TableHead>
              <TableHead className="text-right">{t('col.members')}</TableHead>
              <TableHead>{t('col.order')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((category) => (
              <TableRow key={category.id}>
                <TableCell>
                  <Link
                    to="/stations/$stationId/categories/$categoryId"
                    params={{ stationId, categoryId: category.id }}
                    className="flex items-center gap-2 font-medium hover:underline"
                  >
                    <CategoryColor color={category.color} />
                    {category.name}
                  </Link>
                </TableCell>
                <TableCell>{t(`type.${category.assetType}`)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{membershipLabel(t, category)}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {category.counts.members}
                  {category.counts.schedulable !== category.counts.members && (
                    <span className="block text-muted-foreground">
                      {t('members.schedulable', { schedulable: category.counts.schedulable })}
                    </span>
                  )}
                </TableCell>
                <TableCell>{t(`order.${category.rotationOrder}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
