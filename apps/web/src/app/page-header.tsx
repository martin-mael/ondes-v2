import { ArrowLeftIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/ui/button';

// The top of every page: one title size, one short description style, actions on the right.
// Keep descriptions to one sentence: the page explains the rest where it's needed.

export function PageHeader({
  title,
  description,
  back,
  badge,
  actions,
}: {
  title: ReactNode;
  /** One short sentence under the title. */
  description?: ReactNode;
  /** A `BackButton` to the page's parent list, before the title. */
  back?: ReactNode;
  /** A status next to the title. */
  badge?: ReactNode;
  /** The page's actions, on the right. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {back}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-semibold">{title}</h1>
          {badge}
        </div>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** "← All clocks": a page's way back to its list. Pass `nativeButton={false}` and a `render` link. */
export function BackButton({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2" {...props}>
      <ArrowLeftIcon data-icon="inline-start" />
      {children}
    </Button>
  );
}
