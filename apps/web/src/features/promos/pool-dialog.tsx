import type { VtPool } from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { invalidatePromos, promosApi } from './api.ts';
import { usePromoError, usePromoT } from './messages.ts';

// Create or rename a VT pool (`voice_track:write`).

interface Draft {
  name: string;
  description: string;
  color: string | null;
}

const draftOf = (pool: VtPool | undefined): Draft => ({
  name: pool?.name ?? '',
  description: pool?.description ?? '',
  color: pool?.color ?? null,
});

export function PoolDialog({
  stationId,
  pool,
  open,
  onOpenChange,
}: {
  stationId: string;
  /** Absent: a new pool. */
  pool?: VtPool | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = usePromoT();
  const promoError = usePromoError();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(pool));
  const [nameMissing, setNameMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(pool)),
  );

  useEffect(() => {
    if (open) {
      setDraft(draftOf(pool));
      setNameMissing(false);
      setError(null);
    }
  }, [open, pool]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    setError(null);
    setPending(true);
    const body = {
      name,
      description: draft.description.trim() || null,
      color: draft.color,
    };
    try {
      if (pool) await promosApi.updatePool(stationId, pool.id, body);
      else await promosApi.createPool(stationId, body);
      await invalidatePromos(queryClient, stationId);
      allowLeave();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {guard}
      <Dialog
        open={open}
        onOpenChange={(next) =>
          next ? onOpenChange(true) : confirmDiscard(() => onOpenChange(false))
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pool ? t('pool.editTitle') : t('pool.newTitle')}</DialogTitle>
            <DialogDescription>{t('pool.formDescription')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            {error !== null && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{promoError(error)}</AlertDescription>
              </Alert>
            )}
            <Field data-invalid={nameMissing ? true : undefined}>
              <FieldLabel htmlFor="pool-name">{t('pool.name')}</FieldLabel>
              <Input
                id="pool-name"
                autoFocus
                value={draft.name}
                maxLength={100}
                aria-invalid={nameMissing ? true : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
              <FieldError errors={nameMissing ? [{ message: t('form.invalid') }] : undefined} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pool-description">{t('pool.description')}</FieldLabel>
              <Textarea
                id="pool-description"
                value={draft.description}
                maxLength={2000}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pool-color">{t('pool.color')}</FieldLabel>
              <div className="flex items-center gap-3">
                <Input
                  id="pool-color"
                  type="color"
                  className="h-9 w-14 p-1"
                  disabled={draft.color === null}
                  value={draft.color ?? '#888888'}
                  onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                />
                {/* biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control. */}
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.color === null}
                    onCheckedChange={(on) =>
                      setDraft((d) => ({ ...d, color: on ? null : '#888888' }))
                    }
                  />
                  {t('pool.noColor')}
                </label>
              </div>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {pool ? t('pool.save') : t('pool.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
