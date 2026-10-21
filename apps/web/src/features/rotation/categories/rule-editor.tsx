import {
  type CategoryRule,
  type ComparisonOp,
  comparisonOpSchema,
  RULE_MAX_DEPTH,
  type RuleCondition,
  type RuleGroup,
  type TagKey,
  tagKeySchema,
} from '@ondes/shared';
import { ListPlusIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { type CategoryT, useCategoryT } from './messages.ts';

// Smart rule editor: a tree of all/any groups holding conditions, edited in place. The value
// it reports may be invalid while the user types (an empty value list); the page validates
// with the contract before previewing or saving.

type Child = RuleGroup['children'][number];
type ConditionKind = RuleCondition['kind'];

const KINDS: ConditionKind[] = ['tag', 'tag_number', 'year', 'explicit'];
const TAG_OPS = ['any', 'all', 'none'] as const;

export function newCondition(kind: ConditionKind = 'tag'): RuleCondition {
  switch (kind) {
    case 'tag':
      return { kind, key: 'style', op: 'any', values: [] };
    case 'tag_number':
      return { kind, key: 'energy', op: 'gte', value: 3 };
    case 'year':
      return { kind, op: 'gte', value: 2000 };
    case 'explicit':
      return { kind, value: false };
  }
}

export const newRule = (): CategoryRule => ({
  kind: 'group',
  match: 'all',
  children: [newCondition()],
});

/** Tag values the station already uses, per key, for suggestions. */
export type TagSuggestions = Partial<Record<TagKey, string[]>>;

export function RuleEditor({
  rule,
  onChange,
  suggestions,
}: {
  rule: CategoryRule;
  onChange(rule: CategoryRule): void;
  suggestions: TagSuggestions;
}) {
  return (
    <>
      <GroupEditor group={rule} depth={1} onChange={onChange} suggestions={suggestions} />
      {Object.entries(suggestions).map(([key, values]) => (
        <datalist key={key} id={`tag-values-${key}`}>
          {values?.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      ))}
    </>
  );
}

function GroupEditor({
  group,
  depth,
  onChange,
  onRemove,
  suggestions,
}: {
  group: RuleGroup;
  depth: number;
  onChange(group: RuleGroup): void;
  onRemove?: () => void;
  suggestions: TagSuggestions;
}) {
  const t = useCategoryT();
  const setChild = (index: number, child: Child) =>
    onChange({ ...group, children: group.children.map((c, i) => (i === index ? child : c)) });
  const removeChild = (index: number) =>
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) });
  const add = (child: Child) => onChange({ ...group, children: [...group.children, child] });

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2 data-[depth=1]:border-none data-[depth=1]:p-0"
      data-depth={depth}
      data-testid={`rule-group-${depth}`}
    >
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label={t('rule.field')}
          value={group.match}
          onChange={(e) => onChange({ ...group, match: e.target.value as RuleGroup['match'] })}
        >
          <NativeSelectOption value="all">{t('rule.match.all')}</NativeSelectOption>
          <NativeSelectOption value="any">{t('rule.match.any')}</NativeSelectOption>
        </NativeSelect>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t('rule.removeItem')}
            onClick={onRemove}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {group.children.map((child, index) =>
        child.kind === 'group' ? (
          <GroupEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: children have no ids; position is the identity.
            key={index}
            group={child}
            depth={depth + 1}
            onChange={(next) => setChild(index, next)}
            onRemove={() => removeChild(index)}
            suggestions={suggestions}
          />
        ) : (
          <ConditionRow
            // biome-ignore lint/suspicious/noArrayIndexKey: children have no ids; position is the identity.
            key={index}
            condition={child}
            onChange={(next) => setChild(index, next)}
            onRemove={group.children.length > 1 ? () => removeChild(index) : undefined}
          />
        ),
      )}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => add(newCondition())}>
          <PlusIcon data-icon="inline-start" />
          {t('rule.addCondition')}
        </Button>
        {depth < RULE_MAX_DEPTH && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => add({ kind: 'group', match: 'any', children: [newCondition()] })}
          >
            <ListPlusIcon data-icon="inline-start" />
            {t('rule.addGroup')}
          </Button>
        )}
      </div>
    </div>
  );
}

function opLabel(t: CategoryT, op: ComparisonOp | (typeof TAG_OPS)[number]) {
  return t(`rule.op.${op}`);
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  onChange(condition: RuleCondition): void;
  onRemove?: () => void;
}) {
  const t = useCategoryT();
  const number = (value: string) => (value.trim() === '' ? Number.NaN : Number(value));

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="rule-condition">
      <NativeSelect
        aria-label={t('rule.field')}
        value={condition.kind}
        onChange={(e) => onChange(newCondition(e.target.value as ConditionKind))}
      >
        {KINDS.map((kind) => (
          <NativeSelectOption key={kind} value={kind}>
            {t(`rule.kind.${kind}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      {(condition.kind === 'tag' || condition.kind === 'tag_number') && (
        <NativeSelect
          aria-label={t('rule.kind.tag')}
          value={condition.key}
          onChange={(e) => onChange({ ...condition, key: e.target.value as TagKey })}
        >
          {tagKeySchema.options.map((key) => (
            <NativeSelectOption key={key} value={key}>
              {t(`tag.${key}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}

      {condition.kind === 'tag' && (
        <>
          <NativeSelect
            aria-label={t('rule.op.any')}
            value={condition.op}
            onChange={(e) =>
              onChange({ ...condition, op: e.target.value as (typeof TAG_OPS)[number] })
            }
          >
            {TAG_OPS.map((op) => (
              <NativeSelectOption key={op} value={op}>
                {opLabel(t, op)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <TagValuesInput
            values={condition.values}
            list={`tag-values-${condition.key}`}
            onChange={(values) => onChange({ ...condition, values })}
          />
        </>
      )}

      {(condition.kind === 'tag_number' || condition.kind === 'year') && (
        <>
          <NativeSelect
            aria-label={t('rule.value')}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as ComparisonOp })}
          >
            {comparisonOpSchema.options.map((op) => (
              <NativeSelectOption key={op} value={op}>
                {opLabel(t, op)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            type="number"
            aria-label={t('rule.value')}
            className="w-24"
            value={Number.isNaN(condition.value) ? '' : condition.value}
            onChange={(e) => onChange({ ...condition, value: number(e.target.value) })}
          />
        </>
      )}

      {condition.kind === 'explicit' && (
        <NativeSelect
          aria-label={t('rule.value')}
          value={condition.value ? 'yes' : 'no'}
          onChange={(e) => onChange({ ...condition, value: e.target.value === 'yes' })}
        >
          <NativeSelectOption value="yes">{t('rule.yes')}</NativeSelectOption>
          <NativeSelectOption value="no">{t('rule.no')}</NativeSelectOption>
        </NativeSelect>
      )}

      {onRemove && (
        <Button variant="ghost" size="icon-sm" aria-label={t('rule.removeItem')} onClick={onRemove}>
          <XIcon />
        </Button>
      )}
    </div>
  );
}

const splitValues = (text: string) =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/**
 * Comma-separated values. Keeps the raw text so a trailing comma survives typing, unless the
 * values changed from outside (another row removed above this one).
 */
function TagValuesInput({
  values,
  list,
  onChange,
}: {
  values: string[];
  list: string;
  onChange(values: string[]): void;
}) {
  const t = useCategoryT();
  const [text, setText] = useState(values.join(', '));
  const shown = splitValues(text).join('\n') === values.join('\n') ? text : values.join(', ');
  return (
    <Input
      aria-label={t('rule.values')}
      placeholder={t('rule.values')}
      className="min-w-48 flex-1"
      list={list}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitValues(e.target.value));
      }}
    />
  );
}
