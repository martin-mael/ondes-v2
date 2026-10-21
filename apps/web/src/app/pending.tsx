import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/ui/skeleton';
import { Spinner } from '@/ui/spinner';

// Loading states (CLAUDE.md "Web app"). Most requests answer faster than a loader can be read,
// so nothing shows for the first `PENDING_DELAY_MS`: a loader that flashes for 100 ms is noise.
// After that, pages show a skeleton shaped like their content (it takes the content's space
// from the start, invisible, so nothing jumps when it appears) and buttons show a spinner.

export const PENDING_DELAY_MS = 400;

/** `active`, but only once it has stayed true for `delayMs`. */
export function useDelayed(active: boolean, delayMs = PENDING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

/** A spinner for a pending action (a save button), shown only when the action is slow. */
export function DelayedSpinner({
  when,
  ...props
}: { when: boolean } & React.ComponentProps<typeof Spinner>) {
  return useDelayed(when) ? <Spinner {...props} /> : null;
}

/** Reserves its space at once and fades in after the delay. */
function Reserved({ className, children }: { className?: string; children: React.ReactNode }) {
  const shown = useDelayed(true);
  return (
    <div
      aria-busy
      className={cn(
        'transition-opacity duration-200',
        shown ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Rows of a list or table while it loads. */
export function ListSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <Reserved className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </Reserved>
  );
}

/** A page (title, toolbar, content) while its data loads. */
export function PageSkeleton({ className }: { className?: string }) {
  return (
    <Reserved className={cn('flex flex-col gap-4 p-4 sm:p-6', className)}>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-9 w-full max-w-md" />
      <Skeleton className="h-64 w-full" />
    </Reserved>
  );
}
