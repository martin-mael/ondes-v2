import {
  type PickOutcome,
  type RotationRule,
  type RotationRuleKind,
  rotationRuleKinds,
  rotationRulesSchema,
  type TagMatch,
  tagKeySchema,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../../app/api/client.ts';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { FormAlert } from '../../../app/forms.tsx';
import { DelayedSpinner, ListSkeleton } from '../../../app/pending.tsx';
import { useUnsavedChanges } from '../../../app/unsaved.tsx';
import { categoriesQuery } from '../categories/api.ts';
import { rulesApi, rulesKeys, rulesQuery } from './api.ts';
import { kindLabel, type RulesT, useRulesT, violationText } from './messages.ts';

// Rotation rules settings (#38): the station's ordered rule set, edited as a whole and saved
// with PUT. The list order is the priority (top = 1, relaxed last). "Try a pick" runs the draft
// on a category through the api, and explains every relaxation.

const route = getRouteApi('/_app/stations/$stationId/rotation/rules');

const base = (kind: RotationRuleKind) => ({
  id: `${kind.replaceAll('_', '-')}-${crypto.randomUUID().slice(0, 8)}`,
  enabled: true,
  priority: 1,
  breakable: true,
});

/** A new rule of `kind` with sensible values. */
export function newRule(kind: RotationRuleKind): RotationRule {
  switch (kind) {
    case 'song_rest':
    case 'max_plays':
    case 'search_depth':
      return { ...base(kind), kind };
    case 'artist_separation':
      return { ...base(kind), kind, unit: 'minutes', value: 70, includeFeatured: true };
    case 'title_separation':
      return { ...base(kind), kind, unit: 'minutes', value: 180 };
    case 'album_separation':
      return { ...base(kind), kind, unit: 'minutes', value: 120 };
    case 'same_hour_yesterday':
      return { ...base(kind), kind, windowMinutes: 60 };
    case 'tag_run':
      return { ...base(kind), kind, tag: { key: 'energy', value: '' }, maxRun: 2 };
    case 'segue_ban':
      return {
        ...base(kind),
        kind,
        from: { key: 'style', value: '' },
        to: { key: 'style', value: '' },
      };
    case 'max_tag_per_hour':
      return { ...base(kind), kind, tag: { key: 'style', value: '' }, max: 2 };
    case 'flow':
      return { ...base(kind), kind, maxBpmStep: 10, maxEnergyStep: 0.2 };
  }
}

/** Rules that apply a category setting (rest, caps, depth). */
const CATEGORY_RULES = ['song_rest', 'max_plays', 'search_depth'] as const;

/** Priorities follow the list order. */
const ranked = (rules: RotationRule[]) => rules.map((r, i) => ({ ...r, priority: i + 1 }));

/** The ladder, as the picker runs it: lowest enabled breakable rule first. */
function relaxationLadder(rules: RotationRule[]) {
  return rules
    .filter((r) => r.enabled && r.breakable && r.kind !== 'flow')
    .sort((a, b) => b.priority - a.priority);
}

export function RulesPage() {
  const t = useRulesT();
  const { stationId } = route.useParams();
  const settings = useQuery(rulesQuery(stationId));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {settings.isPending ? (
        <ListSkeleton />
      ) : settings.isError ? (
        isApiError(settings.error, 'forbidden') ? (
          <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
        ) : (
          <FormAlert error={settings.error} />
        )
      ) : (
        <RulesEditor
          // A save resets the draft to what the api stored.
          key={settings.data.updatedAt?.toISOString() ?? 'defaults'}
          stationId={stationId}
          saved={settings.data.rules}
          isDefault={settings.data.updatedAt === null}
        />
      )}
    </div>
  );
}

function RulesEditor({
  stationId,
  saved,
  isDefault,
}: {
  stationId: string;
  saved: RotationRule[];
  isDefault: boolean;
}) {
  const t = useRulesT();
  const queryClient = useQueryClient();
  const [rules, setRules] = useState(() => ranked(saved));
  const [adding, setAdding] = useState<RotationRuleKind>('artist_separation');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showErrors, setShowErrors] = useState(false);

  const change = (next: RotationRule[]) => setRules(ranked(next));
  const parsed = rotationRulesSchema.safeParse(rules);
  const issuesByRule = new Map<number, string[]>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const index = typeof issue.path[0] === 'number' ? issue.path[0] : -1;
      const field = issue.path.slice(1).join('.');
      issuesByRule.set(index, [
        ...(issuesByRule.get(index) ?? []),
        field ? `${field}: ${issue.message}` : issue.message,
      ]);
    }
  }
  const dirty = JSON.stringify(rules) !== JSON.stringify(ranked(saved));
  const { guard } = useUnsavedChanges(dirty);

  const save = async () => {
    setError(null);
    if (!parsed.success) {
      setShowErrors(true);
      return;
    }
    setPending(true);
    try {
      const stored = await rulesApi.save(stationId, { rules: parsed.data });
      queryClient.setQueryData(rulesKeys.settings(stationId), stored);
      toast.success(t('saved'));
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  const ladder = relaxationLadder(rules);
  // These rules carry the categories' own settings: without them, those settings do nothing.
  const ignored = CATEGORY_RULES.filter((kind) => !rules.some((r) => r.kind === kind && r.enabled));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
      {guard}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {isDefault && <Badge variant="secondary">{t('defaults')}</Badge>}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" disabled={!dirty} onClick={() => change(saved)}>
              {t('reset')}
            </Button>
            <Button onClick={save} disabled={pending || (!dirty && !isDefault)}>
              <DelayedSpinner when={pending} data-icon="inline-start" />
              {t('save')}
            </Button>
          </div>
        </div>
        {showErrors && !parsed.success && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{t('invalid')}</AlertDescription>
          </Alert>
        )}
        {error ? <FormAlert error={error} /> : null}
        {ignored.length > 0 && (
          <Alert data-testid="ignored-settings">
            <CircleAlertIcon />
            <AlertDescription>
              <ul>
                {ignored.map((kind) => (
                  <li key={kind}>{t(`ignored.${kind}`)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">{t('ladder')}</p>
        <p className="text-sm" data-testid="ladder">
          <span className="font-medium">{t('ladder.order')}: </span>
          {ladder.length === 0
            ? t('ladder.none')
            : ladder.map((r) => kindLabel(t, r.kind)).join(' → ')}
        </p>

        {rules.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        <ol className="flex flex-col gap-3">
          {rules.map((rule, index) => (
            <li key={rule.id}>
              <RuleCard
                rule={rule}
                first={index === 0}
                last={index === rules.length - 1}
                issues={showErrors ? (issuesByRule.get(index) ?? []) : []}
                onChange={(next) => change(rules.map((r, i) => (i === index ? next : r)))}
                onMove={(delta) => {
                  const next = [...rules];
                  const [moved] = next.splice(index, 1);
                  next.splice(index + delta, 0, moved as RotationRule);
                  change(next);
                }}
                onRemove={() => change(rules.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ol>

        <div className="flex items-end gap-2">
          <Field className="w-auto">
            <FieldLabel htmlFor="rule-add-kind">{t('add.kind')}</FieldLabel>
            <NativeSelect
              id="rule-add-kind"
              value={adding}
              onChange={(e) => setAdding(e.target.value as RotationRuleKind)}
            >
              {rotationRuleKinds.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Button variant="outline" onClick={() => change([...rules, newRule(adding)])}>
            <PlusIcon data-icon="inline-start" />
            {t('add')}
          </Button>
        </div>
      </div>
      <TryPanel stationId={stationId} rules={parsed.success ? parsed.data : null} />
    </div>
  );
}

function RuleCard({
  rule,
  first,
  last,
  issues,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RotationRule;
  first: boolean;
  last: boolean;
  issues: string[];
  onChange: (rule: RotationRule) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const t = useRulesT();
  const name = kindLabel(t, rule.kind);
  const id = (field: string) => `rule-${rule.id}-${field}`;

  return (
    <Card size="sm" data-testid={`rule-${rule.id}`} aria-label={name} role="group">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline">{t('rule.priority', { priority: rule.priority })}</Badge>
          <CardTitle className={rule.enabled ? undefined : 'text-muted-foreground'}>
            {name}
          </CardTitle>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${t('rule.up')}: ${name}`}
              disabled={first}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${t('rule.down')}: ${name}`}
              disabled={last}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${t('rule.remove')}: ${name}`}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-4 text-sm">
          <CheckField
            label={t('rule.enabled')}
            checked={rule.enabled}
            onChange={(enabled) => onChange({ ...rule, enabled })}
          />
          {rule.kind !== 'flow' && (
            <CheckField
              label={t('rule.breakable')}
              checked={rule.breakable}
              onChange={(breakable) => onChange({ ...rule, breakable })}
            />
          )}
        </div>
        <RuleFields rule={rule} id={id} onChange={onChange} />
        {issues.length > 0 && (
          <ul className="text-sm text-destructive" data-testid="rule-issues">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CheckField({
  label,
  checked,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control.
    <label className={`flex items-center gap-2 ${className ?? ''}`}>
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

function NumberField({
  id,
  label,
  value,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field className="w-36">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={0}
        step={step ?? 1}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
    </Field>
  );
}

function TagFields({
  id,
  label,
  tag,
  onChange,
}: {
  id: string;
  label: string;
  tag: TagMatch;
  onChange: (tag: TagMatch) => void;
}) {
  const t = useRulesT();
  return (
    <fieldset className="flex items-end gap-2">
      <Field className="w-32">
        <FieldLabel htmlFor={`${id}-key`}>{label}</FieldLabel>
        <NativeSelect
          id={`${id}-key`}
          value={tag.key}
          onChange={(e) => onChange({ ...tag, key: e.target.value as TagMatch['key'] })}
        >
          {tagKeySchema.options.map((key) => (
            <NativeSelectOption key={key} value={key}>
              {key}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field className="w-36">
        <FieldLabel htmlFor={`${id}-value`}>{t('field.tagValue')}</FieldLabel>
        <Input
          id={`${id}-value`}
          value={tag.value}
          onChange={(e) => onChange({ ...tag, value: e.target.value })}
        />
      </Field>
    </fieldset>
  );
}

function RuleFields({
  rule,
  id,
  onChange,
}: {
  rule: RotationRule;
  id: (field: string) => string;
  onChange: (rule: RotationRule) => void;
}) {
  const t = useRulesT();
  switch (rule.kind) {
    case 'song_rest':
    case 'max_plays':
    case 'search_depth':
    case 'same_hour_yesterday':
      return (
        <div className="flex flex-wrap items-end gap-3">
          {rule.kind === 'same_hour_yesterday' && (
            <Field className="w-32">
              <FieldLabel htmlFor={id('window')}>{t('field.window')}</FieldLabel>
              <NativeSelect
                id={id('window')}
                value={rule.windowMinutes}
                onChange={(e) =>
                  onChange({ ...rule, windowMinutes: Number(e.target.value) as 15 | 30 | 60 })
                }
              >
                {[60, 30, 15].map((minutes) => (
                  <NativeSelectOption key={minutes} value={minutes}>
                    {t('window.option', { minutes })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <FieldDescription>{t(`help.${rule.kind}`)}</FieldDescription>
        </div>
      );
    case 'artist_separation':
    case 'title_separation':
    case 'album_separation':
      return (
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            id={id('value')}
            label={t('field.value')}
            value={rule.value}
            onChange={(value) => onChange({ ...rule, value })}
          />
          <Field className="w-32">
            <FieldLabel htmlFor={id('unit')}>{t('field.unit')}</FieldLabel>
            <NativeSelect
              id={id('unit')}
              value={rule.unit}
              onChange={(e) => onChange({ ...rule, unit: e.target.value as 'minutes' | 'items' })}
            >
              <NativeSelectOption value="minutes">{t('unit.minutes')}</NativeSelectOption>
              <NativeSelectOption value="items">{t('unit.items')}</NativeSelectOption>
            </NativeSelect>
          </Field>
          {rule.kind === 'artist_separation' && (
            <CheckField
              className="pb-2 text-sm"
              label={t('field.includeFeatured')}
              checked={rule.includeFeatured}
              onChange={(includeFeatured) => onChange({ ...rule, includeFeatured })}
            />
          )}
        </div>
      );
    case 'tag_run':
      return (
        <div className="flex flex-wrap items-end gap-3">
          <TagFields
            id={id('tag')}
            label={t('field.tagKey')}
            tag={rule.tag}
            onChange={(tag) => onChange({ ...rule, tag })}
          />
          <NumberField
            id={id('maxRun')}
            label={t('field.maxRun')}
            value={rule.maxRun}
            onChange={(maxRun) => onChange({ ...rule, maxRun })}
          />
        </div>
      );
    case 'segue_ban':
      return (
        <div className="flex flex-wrap items-end gap-3">
          <TagFields
            id={id('from')}
            label={t('field.from')}
            tag={rule.from}
            onChange={(from) => onChange({ ...rule, from })}
          />
          <TagFields
            id={id('to')}
            label={t('field.to')}
            tag={rule.to}
            onChange={(to) => onChange({ ...rule, to })}
          />
        </div>
      );
    case 'max_tag_per_hour':
      return (
        <div className="flex flex-wrap items-end gap-3">
          <TagFields
            id={id('tag')}
            label={t('field.tagKey')}
            tag={rule.tag}
            onChange={(tag) => onChange({ ...rule, tag })}
          />
          <NumberField
            id={id('max')}
            label={t('field.max')}
            value={rule.max}
            onChange={(max) => onChange({ ...rule, max })}
          />
        </div>
      );
    case 'flow':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <NumberField
              id={id('bpm')}
              label={t('field.maxBpmStep')}
              value={rule.maxBpmStep ?? Number.NaN}
              onChange={(v) => onChange({ ...rule, maxBpmStep: Number.isNaN(v) ? null : v })}
            />
            <NumberField
              id={id('energy')}
              label={t('field.maxEnergyStep')}
              step={0.05}
              value={rule.maxEnergyStep ?? Number.NaN}
              onChange={(v) => onChange({ ...rule, maxEnergyStep: Number.isNaN(v) ? null : v })}
            />
          </div>
          <FieldDescription>{t('rule.soft')}</FieldDescription>
        </div>
      );
  }
}

/** `datetime-local` value for an instant, on the station's wall clock. */
function stationInput(date: Date, timeZone: string): string {
  const { date: day, time } = zonedParts(date, timeZone);
  return `${day}T${time}`;
}

/** The instant a `datetime-local` value means on the station's wall clock (not the browser's). */
function fromStationInput(value: string, timeZone: string): Date {
  const [day = '', time = ''] = value.split('T');
  return zonedInstant(day, time.slice(0, 5), timeZone);
}

function TryPanel({ stationId, rules }: { stationId: string; rules: RotationRule[] | null }) {
  const t = useRulesT();
  const timeZone = findStation(useOrgs(), stationId)?.station.timezone ?? 'UTC';
  const categories = useQuery(categoriesQuery(stationId));
  const [categoryId, setCategoryId] = useState('');
  const [at, setAt] = useState(() => stationInput(new Date(), timeZone));
  const [result, setResult] = useState<PickOutcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const items = categories.data?.items ?? [];
  const chosen = categoryId || items[0]?.id || '';

  const run = async () => {
    if (!chosen || !rules) return;
    setPending(true);
    setError(null);
    try {
      const response = await rulesApi.pick(stationId, {
        slots: [{ categoryId: chosen, at: fromStationInput(at, timeZone).toISOString() }],
        rules,
        explain: true,
      });
      setResult(response.picks[0] ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>{t('try.title')}</CardTitle>
        <CardDescription>{t('try.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {categories.isSuccess && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('try.noCategory')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field className="w-48">
              <FieldLabel htmlFor="try-category">{t('try.category')}</FieldLabel>
              <NativeSelect
                id="try-category"
                value={chosen}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {items.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="w-52">
              <FieldLabel htmlFor="try-at">{t('try.at', { timeZone })}</FieldLabel>
              <Input
                id="try-at"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>
            <Button onClick={run} disabled={pending || !chosen || !rules || !at}>
              <DelayedSpinner when={pending} data-icon="inline-start" />
              {t('try.run')}
            </Button>
          </div>
        )}
        {error ? <FormAlert error={error} /> : null}
        {result && <PickExplanation t={t} result={result} />}
      </CardContent>
    </Card>
  );
}

function PickExplanation({ t, result }: { t: RulesT; result: PickOutcome }) {
  const picked = result.ranked?.find((r) => r.picked);
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pick-result">
      {result.asset ? (
        <p className="font-medium">
          {t('try.picked', {
            title: `${result.asset.artists.join(', ')} – ${result.asset.title}`,
          })}
        </p>
      ) : (
        <div data-testid="unfilled">
          <p className="font-medium">
            {result.unfilled?.reason === 'no_candidates' ? t('try.noCandidates') : t('try.nothing')}
          </p>
          <ul className="list-disc pl-4">
            {result.unfilled?.blockedBy.map((b) => (
              <li key={b.ruleId}>
                {t('try.blockedBy', { rule: kindLabel(t, b.kind), count: b.candidates })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.asset && result.relaxed.length === 0 && (
        <p className="text-muted-foreground">{t('try.clean')}</p>
      )}
      {result.relaxed.map((relaxed) => (
        <Alert key={relaxed.rule} data-testid="relaxed">
          <CircleAlertIcon />
          <AlertDescription>
            <p className="font-medium text-foreground">
              {t('try.relaxed', { rule: kindLabel(t, relaxed.rule) })}
            </p>
            <p>{t('try.relaxedWhy')}</p>
            <ul className="list-disc pl-4">
              {picked?.violations
                .filter((v) => v.kind === relaxed.rule)
                .map((v) => (
                  <li key={v.ruleId}>{violationText(t, v)}</li>
                ))}
            </ul>
          </AlertDescription>
        </Alert>
      ))}
      {result.ranked && result.ranked.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('try.candidates')}</p>
          <ol className="flex flex-col gap-1.5" data-testid="ranked">
            {result.ranked.slice(0, 25).map((c) => (
              <li
                key={c.assetId}
                className={c.picked ? 'rounded-md bg-muted px-2 py-1' : 'px-2 py-1'}
              >
                <span className={c.picked ? 'font-medium' : undefined}>
                  {c.position + 1}. {c.artists.join(', ')} – {c.title}
                </span>
                {c.violations.length === 0 ? (
                  <span className="ml-2 text-muted-foreground">{t('try.eligible')}</span>
                ) : (
                  <ul className="pl-4 text-muted-foreground">
                    {[...c.violations, ...c.notes].map((v) => (
                      <li key={v.ruleId}>{violationText(t, v)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
