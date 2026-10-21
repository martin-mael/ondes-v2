import {
  type AssetType,
  assetTypeSchema,
  CATEGORY_DEFAULTS,
  type CategoryDetail,
  type CategoryMember,
  type CategoryRule,
  categoryRuleSchema,
  createCategorySchema,
  type RotationOrder,
  rotationOrderSchema,
  tagSchema,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CircleAlertIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { isApiError, request } from '../../../app/api/client.ts';
import { type FieldErrors, FormAlert, fieldErrors } from '../../../app/forms.tsx';
import { DelayedSpinner, PageSkeleton } from '../../../app/pending.tsx';
import { useUnsavedChanges } from '../../../app/unsaved.tsx';
import { categoriesApi, categoryKeys, categoryQuery, useDraftPreview } from './api.ts';
import { useCategoryT } from './messages.ts';
import { ManualMembers, PreviewPanel } from './preview-panel.tsx';
import { newRule, RuleEditor, type TagSuggestions } from './rule-editor.tsx';

// Create and edit a category, with a live preview of its members as the rule and the manual
// list change. The same page serves `categories/new` and `categories/$categoryId`.

const editRoute = getRouteApi('/_app/stations/$stationId/categories/$categoryId');
const newRoute = getRouteApi('/_app/stations/$stationId/categories/new');

interface Draft {
  name: string;
  description: string;
  /** `null`: no colour. */
  color: string | null;
  assetType: AssetType;
  rule: CategoryRule | null;
  rotationOrder: RotationOrder;
  searchDepthPercent: string;
  restMinutes: string;
  maxPlaysPerDay: string;
  maxPlaysPerWeek: string;
  members: CategoryMember[];
}

const DEFAULT_COLOR = '#3b82f6';

function draftOf(category: CategoryDetail | null): Draft {
  return {
    name: category?.name ?? '',
    description: category?.description ?? '',
    color: category?.color ?? null,
    assetType: category?.assetType ?? CATEGORY_DEFAULTS.assetType,
    // New categories start manual-only, so the preview works before a rule is complete.
    rule: category?.rule ?? null,
    rotationOrder: category?.rotationOrder ?? CATEGORY_DEFAULTS.rotationOrder,
    searchDepthPercent: String(
      category?.searchDepthPercent ?? CATEGORY_DEFAULTS.searchDepthPercent,
    ),
    restMinutes: String(category?.restMinutes ?? CATEGORY_DEFAULTS.restMinutes),
    maxPlaysPerDay: category?.maxPlaysPerDay?.toString() ?? '',
    maxPlaysPerWeek: category?.maxPlaysPerWeek?.toString() ?? '',
    members: category?.members ?? [],
  };
}

const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** Settings that can't be left empty (they have no "unset" value). */
const REQUIRED_NUMBERS = ['searchDepthPercent', 'restMinutes'] as const;

/** The draft as the api's body, validated by the contract. */
function toBody(draft: Draft) {
  return createCategorySchema.safeParse({
    name: draft.name,
    description: draft.description.trim() === '' ? null : draft.description,
    color: draft.color,
    assetType: draft.assetType,
    rule: draft.rule,
    rotationOrder: draft.rotationOrder,
    searchDepthPercent: Number(draft.searchDepthPercent),
    restMinutes: Number(draft.restMinutes),
    maxPlaysPerDay: numberOrNull(draft.maxPlaysPerDay),
    maxPlaysPerWeek: numberOrNull(draft.maxPlaysPerWeek),
    members: draft.members,
  });
}

const tagsResponseSchema = z.object({ tags: z.array(tagSchema) });

function useTagSuggestions(stationId: string): TagSuggestions {
  const tags = useQuery({
    queryKey: ['stations', stationId, 'tags'],
    queryFn: ({ signal }) =>
      request(`/stations/${stationId}/tags`, { schema: tagsResponseSchema, signal }),
  });
  return useMemo(() => {
    const out: TagSuggestions = {};
    for (const tag of tags.data?.tags ?? []) out[tag.key] = [...(out[tag.key] ?? []), tag.value];
    return out;
  }, [tags.data]);
}

export function NewCategoryPage() {
  const { stationId } = newRoute.useParams();
  return <CategoryEditor stationId={stationId} category={null} />;
}

export function EditCategoryPage() {
  const { stationId, categoryId } = editRoute.useParams();
  const detail = useQuery(categoryQuery(stationId, categoryId));
  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError) {
    return (
      <div className="p-6">
        <FormAlert error={detail.error} />
      </div>
    );
  }
  // Keyed so a refetched category resets the form only when another one is opened.
  return <CategoryEditor key={detail.data.id} stationId={stationId} category={detail.data} />;
}

function CategoryEditor({
  stationId,
  category,
}: {
  stationId: string;
  category: CategoryDetail | null;
}) {
  const t = useCategoryT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const suggestions = useTagSuggestions(stationId);
  const [draft, setDraft] = useState(() => draftOf(category));
  // What's saved: leaving with a different draft asks first.
  const [saved, setSaved] = useState(draft);
  const { guard, allowLeave } = useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(saved));
  const [playsPerDay, setPlaysPerDay] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // While the rule is incomplete, the preview keeps the last valid one (and says so).
  const ruleValid = draft.rule === null || categoryRuleSchema.safeParse(draft.rule).success;
  const [lastValidRule, setLastValidRule] = useState<CategoryRule | null>(
    ruleValid ? draft.rule : null,
  );
  if (ruleValid && lastValidRule !== draft.rule) setLastValidRule(draft.rule);
  const plays = Number(playsPerDay);
  const preview = useDraftPreview(stationId, {
    assetType: draft.assetType,
    rule: lastValidRule,
    members: draft.members,
    limit: 100,
    manualLimit: 1000,
    ...(playsPerDay && plays > 0 ? { playsPerDay: plays } : {}),
  });

  const save = async () => {
    const parsed = toBody(draft);
    setFormError(null);
    const missing: FieldErrors = Object.fromEntries(
      REQUIRED_NUMBERS.filter((name) => draft[name].trim() === '').map((name) => [
        name,
        [{ message: t('field.required') }],
      ]),
    );
    if (!parsed.success || Object.keys(missing).length > 0) {
      setErrors({ ...(parsed.success ? {} : fieldErrors(parsed.error)), ...missing });
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const stored = category
        ? await categoriesApi.update(stationId, category.id, parsed.data)
        : await categoriesApi.create(stationId, parsed.data);
      setSaved(draft);
      queryClient.setQueryData(categoryKeys.one(stationId, stored.id), stored);
      await queryClient.invalidateQueries({ queryKey: categoryKeys.all(stationId) });
      toast.success(category ? t('editor.saved') : t('editor.created'));
      if (!category) {
        allowLeave();
        await navigate({
          to: '/stations/$stationId/categories/$categoryId',
          params: { stationId, categoryId: stored.id },
        });
      }
    } catch (error) {
      if (isApiError(error, 'category_name_taken')) {
        setErrors({ name: [{ message: t('editor.nameTaken') }] });
      } else if (isApiError(error, 'unknown_asset')) {
        setFormError(t('editor.unknownAsset'));
      } else {
        setFormError(error);
      }
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!category || !window.confirm(t('editor.deleteConfirm'))) return;
    try {
      await categoriesApi.remove(stationId, category.id);
      queryClient.removeQueries({ queryKey: categoryKeys.one(stationId, category.id) });
      await queryClient.invalidateQueries({ queryKey: categoryKeys.all(stationId) });
      toast.success(t('editor.deleted'));
      allowLeave();
      await navigate({ to: '/stations/$stationId/categories', params: { stationId } });
    } catch (error) {
      setFormError(error);
    }
  };

  const field = (name: keyof Draft) => ({
    id: `category-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      {guard}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/stations/$stationId/categories" params={{ stationId }} />}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {t('editor.back')}
        </Button>
        <h1 className="font-heading text-xl font-semibold">
          {category ? t('editor.editTitle') : t('editor.newTitle')}
        </h1>
        <div className="ml-auto flex gap-2">
          {category && (
            <Button variant="destructive" onClick={remove}>
              <Trash2Icon data-icon="inline-start" />
              {t('editor.delete')}
            </Button>
          )}
          <Button onClick={save} disabled={pending}>
            <DelayedSpinner when={pending} data-icon="inline-start" />
            {category ? t('editor.save') : t('editor.create')}
          </Button>
        </div>
      </div>
      {typeof formError === 'string' ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : formError ? (
        <FormAlert error={formError} />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('editor.general')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <div className="flex gap-3">
                  <Field data-invalid={errors.name ? true : undefined}>
                    <FieldLabel htmlFor="category-name">{t('field.name')}</FieldLabel>
                    <Input
                      {...field('name')}
                      value={draft.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                    <FieldError errors={errors.name} />
                  </Field>
                  <Field className="w-auto shrink-0">
                    <FieldLabel htmlFor="category-color">{t('field.color')}</FieldLabel>
                    {draft.color === null ? (
                      <Button
                        id="category-color"
                        variant="outline"
                        onClick={() => update({ color: DEFAULT_COLOR })}
                      >
                        {t('field.colorNone')}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Input
                          {...field('color')}
                          type="color"
                          className="w-12 p-0.5"
                          value={draft.color}
                          onChange={(e) => update({ color: e.target.value })}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('field.colorClear')}
                          onClick={() => update({ color: null })}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    )}
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="category-description">{t('field.description')}</FieldLabel>
                  <Textarea
                    {...field('description')}
                    rows={2}
                    value={draft.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                  <FieldError errors={errors.description} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="category-assetType">{t('field.assetType')}</FieldLabel>
                  <NativeSelect
                    {...field('assetType')}
                    value={draft.assetType}
                    onChange={(e) => update({ assetType: e.target.value as AssetType })}
                  >
                    {assetTypeSchema.options.map((type) => (
                      <NativeSelectOption key={type} value={type}>
                        {t(`type.${type}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('rule.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {draft.rule ? (
                <>
                  <RuleEditor
                    rule={draft.rule}
                    onChange={(rule) => update({ rule })}
                    suggestions={suggestions}
                  />
                  {errors.rule && <FieldError errors={errors.rule} />}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => update({ rule: null })}
                  >
                    {t('rule.remove')}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{t('rule.none')}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => update({ rule: newRule() })}
                  >
                    {t('rule.add')}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <ManualMembers
            stationId={stationId}
            assetType={draft.assetType}
            members={draft.members}
            preview={preview.data}
            onChange={(members) => update({ members })}
          />

          <Card>
            <CardHeader>
              <CardTitle>{t('field.rotation')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="category-rotationOrder">
                    {t('field.rotationOrder')}
                  </FieldLabel>
                  <NativeSelect
                    {...field('rotationOrder')}
                    value={draft.rotationOrder}
                    onChange={(e) => update({ rotationOrder: e.target.value as RotationOrder })}
                  >
                    {rotationOrderSchema.options.map((order) => (
                      <NativeSelectOption key={order} value={order}>
                        {t(`order.${order}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <NumberField
                  name="searchDepthPercent"
                  label={t('field.searchDepth')}
                  description={t('field.searchDepthHelp')}
                  value={draft.searchDepthPercent}
                  errors={errors}
                  onChange={(searchDepthPercent) => update({ searchDepthPercent })}
                />
                <NumberField
                  name="restMinutes"
                  label={t('field.rest')}
                  description={t('field.restHelp')}
                  value={draft.restMinutes}
                  errors={errors}
                  onChange={(restMinutes) => update({ restMinutes })}
                />
                <div />
                <NumberField
                  name="maxPlaysPerDay"
                  label={t('field.maxPerDay')}
                  placeholder={t('field.noLimit')}
                  value={draft.maxPlaysPerDay}
                  errors={errors}
                  onChange={(maxPlaysPerDay) => update({ maxPlaysPerDay })}
                />
                <NumberField
                  name="maxPlaysPerWeek"
                  label={t('field.maxPerWeek')}
                  placeholder={t('field.noLimit')}
                  value={draft.maxPlaysPerWeek}
                  errors={errors}
                  onChange={(maxPlaysPerWeek) => update({ maxPlaysPerWeek })}
                />
              </FieldGroup>
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <PreviewPanel
            preview={preview.data}
            loading={preview.isFetching}
            stale={!ruleValid}
            playsPerDay={playsPerDay}
            onPlaysPerDay={setPlaysPerDay}
            onExclude={(assetId) =>
              update({
                members: [
                  ...draft.members.filter((m) => m.assetId !== assetId),
                  { assetId, mode: 'exclude' },
                ],
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

function NumberField({
  name,
  label,
  description,
  placeholder,
  value,
  errors,
  onChange,
}: {
  name: keyof Draft;
  label: string;
  description?: string;
  placeholder?: string;
  value: string;
  errors: FieldErrors;
  onChange(value: string): void;
}) {
  const id = `category-${name}`;
  return (
    <Field data-invalid={errors[name] ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={0}
        placeholder={placeholder}
        aria-invalid={errors[name] ? true : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={errors[name]} />
    </Field>
  );
}
