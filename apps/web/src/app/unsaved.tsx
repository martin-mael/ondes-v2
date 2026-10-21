import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { useI18n } from './i18n/i18n.tsx';

// Unsaved changes (CLAUDE.md "Web app"): a page that edits something asks before it's left
// with changes not saved, inside the app (a dialog) and when the tab closes or reloads (the
// browser's own prompt).
//
//   const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(dirty);
//   …save, then `allowLeave()` before navigating away on purpose…
//   …a dialog's close goes through `confirmDiscard(() => onOpenChange(false))`…
//   return <>{page}{guard}</>;

export function useUnsavedChanges(dirty: boolean): {
  guard: React.ReactNode;
  allowLeave(): void;
  confirmDiscard(discard: () => void): void;
} {
  const { t } = useI18n();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Set by `allowLeave()` for the save's own navigation; cleared once nothing is unsaved.
  const leaving = useRef(false);
  if (!dirty) leaving.current = false;
  const blocks = () => dirtyRef.current && !leaving.current;
  const blocker = useBlocker({
    shouldBlockFn: blocks,
    enableBeforeUnload: blocks,
    withResolver: true,
  });
  const allowLeave = useCallback(() => {
    leaving.current = true;
  }, []);
  // A close (a dialog's) waiting for the answer.
  const [discarding, setDiscarding] = useState<(() => void) | null>(null);
  const confirmDiscard = useCallback((discard: () => void) => {
    if (dirtyRef.current && !leaving.current) setDiscarding(() => discard);
    else discard();
  }, []);
  const stay = () => {
    setDiscarding(null);
    blocker.reset?.();
  };
  const leave = () => {
    if (discarding) {
      setDiscarding(null);
      discarding();
    } else {
      blocker.proceed?.();
    }
  };

  const guard = (
    <Dialog
      open={blocker.status === 'blocked' || discarding !== null}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('unsaved.title')}</DialogTitle>
          <DialogDescription>{t('unsaved.body')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={stay}>
            {t('unsaved.stay')}
          </Button>
          <Button variant="destructive" onClick={leave}>
            {t('unsaved.leave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { guard, allowLeave, confirmDiscard };
}
