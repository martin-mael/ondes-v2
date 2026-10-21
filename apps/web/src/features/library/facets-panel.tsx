import {
  ANALYSIS_STATES,
  type AnalysisState,
  type LibraryFacets,
  type TagKey,
  tagKeySchema,
  VALIDITIES,
} from '@ondes/shared';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { type LibrarySearchParams, parseTagParam, tagParamOf, toggled } from './filters.ts';
import { formatDuration, parseDuration } from './format.ts';
import { type LibraryT, useLibraryT } from './messages.ts';

// Facet filters (#23): counts per type, tag, analysis state and scheduling window (each
// counted without its own filter, by the api), and range filters. Everything writes to the
// URL through `update`.

type Update = (patch: Partial<LibrarySearchParams>) => void;

const TAGS_SHOWN = 8;
const PLAYED_DAYS = [7, 30, 90, 365];

export function FacetsPanel({
  facets,
  params,
  update,
}: {
  facets: LibraryFacets | undefined;
  params: LibrarySearchParams;
  update: Update;
}) {
  const t = useLibraryT();
  const selectedTags = (params.tag ?? []).flatMap((p) => parseTagParam(p) ?? []);
  const tagKeys = tagKeySchema.options.filter(
    (key) => facets?.tags.some((tag) => tag.key === key) || selectedTags.some((s) => s.key === key),
  );
  const count = (n: number | undefined) => n ?? 0;

  return (
    <div className="flex flex-col gap-4 text-xs">
      <FacetGroup title={t('facets.type')}>
        {(facets?.types ?? []).map(({ type, count: c }) => (
          <FacetOption
            key={type}
            label={t(`type.${type}`)}
            count={c}
            checked={params.type?.includes(type) ?? false}
            onChange={() => update({ type: toggled(params.type, type) })}
          />
        ))}
        {(params.type ?? [])
          .filter((type) => !facets?.types.some((f) => f.type === type))
          .map((type) => (
            <FacetOption
              key={type}
              label={t(`type.${type}`)}
              count={0}
              checked
              onChange={() => update({ type: toggled(params.type, type) })}
            />
          ))}
      </FacetGroup>

      {tagKeys.map((key) => (
        <TagFacet
          key={key}
          tagKey={key}
          facets={facets}
          selected={selectedTags.filter((s) => s.key === key).map((s) => s.value)}
          onToggle={(value) => update({ tag: toggled(params.tag, tagParamOf({ key, value })) })}
          t={t}
        />
      ))}

      <FacetGroup title={t('facets.analysis')}>
        {ANALYSIS_STATES.map((state: AnalysisState) => (
          <FacetOption
            key={state}
            label={t(`analysis.${state}`)}
            count={count(facets?.analysis.find((a) => a.state === state)?.count)}
            checked={params.analysis?.includes(state) ?? false}
            onChange={() => update({ analysis: toggled(params.analysis, state) })}
          />
        ))}
      </FacetGroup>

      <FacetGroup title={t('facets.validity')}>
        {VALIDITIES.map((v) => (
          <FacetOption
            key={v}
            label={t(`validity.${v}`)}
            count={count(facets?.validity.find((f) => f.validity === v)?.count)}
            checked={params.validity?.includes(v) ?? false}
            onChange={() => update({ validity: toggled(params.validity, v) })}
          />
        ))}
      </FacetGroup>

      <FacetGroup title={t('facets.more')}>
        <RangeFilter
          label={t('facets.duration')}
          min={params.durMin}
          max={params.durMax}
          format={(s) => formatDuration(s * 1000)}
          parse={parseDuration}
          onChange={(durMin, durMax) => update({ durMin, durMax })}
          t={t}
        />
        <RangeFilter
          label={t('facets.bpm')}
          min={params.bpmMin}
          max={params.bpmMax}
          onChange={(bpmMin, bpmMax) => update({ bpmMin, bpmMax })}
          t={t}
        />
        <RangeFilter
          label={t('facets.year')}
          min={params.yearMin}
          max={params.yearMax}
          onChange={(yearMin, yearMax) => update({ yearMin, yearMax })}
          t={t}
        />
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('facets.added')}</span>
          <div className="grid grid-cols-2 gap-1">
            <Input
              type="date"
              aria-label={t('facets.added.from')}
              value={params.addedFrom ?? ''}
              onChange={(e) => update({ addedFrom: e.target.value || undefined })}
            />
            <Input
              type="date"
              aria-label={t('facets.added.to')}
              value={params.addedTo ?? ''}
              onChange={(e) => update({ addedTo: e.target.value || undefined })}
            />
          </div>
        </div>
        <SelectFilter
          label={t('facets.explicit')}
          value={params.explicit === undefined ? '' : String(params.explicit)}
          options={[
            ['', t('facets.explicit.any')],
            ['true', t('facets.explicit.yes')],
            ['false', t('facets.explicit.no')],
          ]}
          onChange={(v) => update({ explicit: v === '' ? undefined : v === 'true' })}
        />
        <SelectFilter
          label={t('facets.played')}
          value={params.never ? 'never' : params.notPlayedDays ? String(params.notPlayedDays) : ''}
          options={[
            ['', t('facets.played.any')],
            ['never', t('facets.played.never')],
            ...PLAYED_DAYS.map((days): [string, string] => [
              String(days),
              t('facets.played.days', { days }),
            ]),
          ]}
          onChange={(v) =>
            update({
              never: v === 'never' || undefined,
              notPlayedDays: v === '' || v === 'never' ? undefined : Number(v),
            })
          }
        />
      </FacetGroup>
    </div>
  );
}

function FacetGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <fieldset aria-labelledby={id} className="flex flex-col gap-1">
      <legend id={id} className="mb-1 font-semibold">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function FacetOption({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <Label
        htmlFor={id}
        className={`flex-1 truncate font-normal ${count === 0 && !checked ? 'text-muted-foreground' : ''}`}
      >
        {label}
      </Label>
      <span className="text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
    </div>
  );
}

function TagFacet({
  tagKey,
  facets,
  selected,
  onToggle,
  t,
}: {
  tagKey: TagKey;
  facets: LibraryFacets | undefined;
  selected: string[];
  onToggle: (value: string) => void;
  t: LibraryT;
}) {
  const [expanded, setExpanded] = useState(false);
  const [find, setFind] = useState('');
  const values = (facets?.tags ?? []).filter((tag) => tag.key === tagKey);
  const lower = selected.map((s) => s.toLowerCase());
  const isSelected = (value: string) => lower.includes(value.toLowerCase());
  // Selected values always show, even when the other filters leave them no asset.
  const missing = selected.filter(
    (s) => !values.some((v) => v.value.toLowerCase() === s.toLowerCase()),
  );
  const needle = find.trim().toLowerCase();
  const matching = needle ? values.filter((v) => v.value.toLowerCase().includes(needle)) : values;
  const shown = expanded || needle ? matching : matching.slice(0, TAGS_SHOWN);
  const keyLabel = t(`tagKey.${tagKey}`);

  return (
    <FacetGroup title={keyLabel}>
      {values.length > TAGS_SHOWN && (
        <Input
          aria-label={t('facets.tagSearch', { key: keyLabel })}
          placeholder={t('facets.tagSearch', { key: keyLabel })}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          className="mb-1 h-7"
        />
      )}
      {missing.map((value) => (
        <FacetOption
          key={`missing:${value}`}
          label={value}
          count={0}
          checked
          onChange={() => onToggle(value)}
        />
      ))}
      {shown.map((tag) => (
        <FacetOption
          key={tag.id}
          label={tag.value}
          count={tag.count}
          checked={isSelected(tag.value)}
          onChange={() => onToggle(tag.value)}
        />
      ))}
      {!needle && matching.length > TAGS_SHOWN && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t('facets.showLess')
            : t('facets.showMore', { count: matching.length - TAGS_SHOWN })}
        </Button>
      )}
    </FacetGroup>
  );
}

function RangeFilter({
  label,
  min,
  max,
  format = String,
  parse = (v) => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v)),
  onChange,
  t,
}: {
  label: string;
  min: number | undefined;
  max: number | undefined;
  format?: (value: number) => string;
  parse?: (value: string) => number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
  t: LibraryT;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <div className="grid grid-cols-2 gap-1">
        <CommitInput
          label={`${label} ${t('facets.min')}`}
          placeholder={t('facets.min')}
          value={min === undefined ? '' : format(min)}
          onCommit={(v) => onChange(parse(v), max)}
        />
        <CommitInput
          label={`${label} ${t('facets.max')}`}
          placeholder={t('facets.max')}
          value={max === undefined ? '' : format(max)}
          onCommit={(v) => onChange(min, parse(v))}
        />
      </div>
    </div>
  );
}

/** A text input that reports its value on blur or Enter, not on every key. */
function CommitInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <Input
      aria-label={label}
      placeholder={placeholder}
      inputMode="numeric"
      className="h-7"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [value: string, label: string][];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {label}
      </Label>
      <NativeSelect id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <NativeSelectOption key={v} value={v}>
            {l}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
