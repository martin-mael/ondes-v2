import type {
  AssetType,
  CategoryMember,
  CategoryPreview,
  ManualEffect,
  MemberMode,
} from '@ondes/shared';
import { BanIcon, ClockIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { useAssetSearch } from './api.ts';
import { useCategoryT } from './messages.ts';

// The editor's right-hand side: live counts, turnover projection and members of the draft,
// and the manual include/exclude list with a library search.

const effectVariant: Record<ManualEffect, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  added: 'default',
  excluded: 'secondary',
  redundant: 'outline',
  wrong_type: 'destructive',
};

const artistTitle = (artists: string[], title: string) =>
  artists.length > 0 ? `${artists.join(', ')} – ${title}` : title;

export function PreviewPanel({
  preview,
  loading,
  stale,
  playsPerDay,
  onPlaysPerDay,
  onExclude,
}: {
  preview: CategoryPreview | undefined;
  loading: boolean;
  /** The rule being edited is incomplete: the preview shows the last valid one. */
  stale: boolean;
  playsPerDay: string;
  onPlaysPerDay(value: string): void;
  onExclude(assetId: string): void;
}) {
  const t = useCategoryT();
  const counts = preview?.counts;
  const hidden = preview && counts ? counts.members - preview.items.length : 0;

  return (
    <Card data-testid="category-preview">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('preview.title')}
          {loading && <Spinner />}
        </CardTitle>
        {counts && (
          <CardDescription className="flex flex-wrap gap-x-3 gap-y-1">
            <span className="font-medium text-foreground" data-testid="preview-members">
              {t('preview.members', { count: counts.members })}
            </span>
            <span>{t('preview.schedulable', { count: counts.schedulable })}</span>
            {counts.ruleMatches > 0 && (
              <span>{t('preview.ruleMatches', { count: counts.ruleMatches })}</span>
            )}
            {counts.manualOnly > 0 && (
              <span>{t('preview.manualOnly', { count: counts.manualOnly })}</span>
            )}
            {counts.excluded > 0 && (
              <span>{t('preview.excluded', { count: counts.excluded })}</span>
            )}
            <span>
              {t('preview.duration', {
                hours: Math.round((counts.totalDurationMs / 3_600_000) * 10) / 10,
              })}
            </span>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {stale && (
          <p className="text-sm text-muted-foreground" data-testid="preview-stale">
            {t('preview.stale')}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-36">
            <FieldLabel htmlFor="plays-per-day">{t('preview.playsPerDay')}</FieldLabel>
            <Input
              id="plays-per-day"
              type="number"
              min={1}
              value={playsPerDay}
              onChange={(e) => onPlaysPerDay(e.target.value)}
            />
          </Field>
          <p className="flex-1 text-sm text-muted-foreground" data-testid="preview-turnover">
            {preview?.turnoverDays != null
              ? t('preview.turnover', {
                  days: Math.round(preview.turnoverDays * 10) / 10,
                })
              : t('preview.turnoverHelp')}
          </p>
        </div>

        {preview && preview.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preview.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {preview?.items.map((item) => (
              <li key={item.assetId} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {artistTitle(item.artists, item.title)}
                  {item.year && <span className="text-muted-foreground"> · {item.year}</span>}
                </span>
                {!item.schedulable && (
                  <ClockIcon
                    className="size-3.5 text-muted-foreground"
                    aria-label={t('preview.notSchedulable')}
                  />
                )}
                <Badge variant="outline">{t(`preview.source.${item.source}`)}</Badge>
                {item.source !== 'manual' && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${t('manual.exclude')} ${item.title}`}
                    title={t('manual.exclude')}
                    onClick={() => onExclude(item.assetId)}
                  >
                    <BanIcon />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && (
          <p className="text-xs text-muted-foreground">{t('preview.more', { count: hidden })}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function ManualMembers({
  stationId,
  assetType,
  members,
  preview,
  onChange,
}: {
  stationId: string;
  assetType: AssetType;
  members: CategoryMember[];
  preview: CategoryPreview | undefined;
  onChange(members: CategoryMember[]): void;
}) {
  const t = useCategoryT();
  const [q, setQ] = useState('');
  const search = useAssetSearch(stationId, q, assetType);
  const known = new Map(preview?.manual.map((m) => [m.assetId, m]));
  const set = (assetId: string, mode: MemberMode) =>
    onChange([...members.filter((m) => m.assetId !== assetId), { assetId, mode }]);
  const remove = (assetId: string) => onChange(members.filter((m) => m.assetId !== assetId));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('manual.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Input
            type="search"
            aria-label={t('manual.search')}
            placeholder={t('manual.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q.trim() && search.data && (
            <ul className="flex flex-col divide-y divide-border text-sm" data-testid="asset-search">
              {search.data.items.map((asset) => {
                const current = members.find((m) => m.assetId === asset.id)?.mode;
                return (
                  <li key={asset.id} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      {artistTitle(asset.artists, asset.title)}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={current === 'include'}
                      aria-label={`${t('manual.include')} ${asset.title}`}
                      onClick={() => set(asset.id, 'include')}
                    >
                      <PlusIcon data-icon="inline-start" />
                      {t('manual.include')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={current === 'exclude'}
                      aria-label={`${t('manual.exclude')} ${asset.title}`}
                      onClick={() => set(asset.id, 'exclude')}
                    >
                      <BanIcon data-icon="inline-start" />
                      {t('manual.exclude')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('manual.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm" data-testid="manual-members">
            {members.map((member) => {
              const entry = known.get(member.assetId);
              return (
                <li key={member.assetId} className="flex items-center gap-2 py-1.5">
                  {member.mode === 'include' ? (
                    <PlusIcon className="size-3.5 text-muted-foreground" />
                  ) : (
                    <BanIcon className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {entry ? artistTitle(entry.artists, entry.title) : t('manual.unknown')}
                  </span>
                  {entry && (
                    <Badge variant={effectVariant[entry.effect]}>
                      {t(`manual.effect.${entry.effect}`)}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${t('manual.remove')} ${entry?.title ?? member.assetId}`}
                    onClick={() => remove(member.assetId)}
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
