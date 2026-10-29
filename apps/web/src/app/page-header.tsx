import { cn } from 'cn';
import { ArrowLeftIcon } from 'lucide-react';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';
import { Button } from '@/ui/button';
import { SidebarTrigger } from '@/ui/sidebar';

// Every signed-in page is a `Page`: a sticky header bar (title, one line of description,
// actions on the right), level with the sidebar's station switcher, over the page's content.
// The bar stays in view while the page scrolls, so an editor's Save is always one click away.
//
// Widths, all left-aligned so titles and content share one edge:
// - `full`: tools that use the whole window (calendar, log, grid, library, editors);
// - `list`: lists and tables, which get hard to scan when a row spans 1500px;
// - `form`: settings and forms.
// The bar's content follows the page's width, so its actions end where the content ends.

export type PageWidth = 'full' | 'list' | 'form';

const WIDTH: Record<PageWidth, string> = {
  full: '',
  list: 'max-w-5xl',
  form: 'max-w-3xl',
};

const PageWidthContext = createContext<PageWidth>('full');

export function Page({
  header,
  width = 'full',
  fill = false,
  className,
  children,
}: {
  /** A `PageHeader`. */
  header: ReactNode;
  width?: PageWidth;
  /** The content fills the window below the bar and scrolls inside (calendar, library). */
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PageWidthContext.Provider value={width}>
      {/* A filled page is exactly the window's height: `flex-1` would let it grow instead. */}
      <div
        className={cn('flex min-w-0 flex-col', fill ? 'h-svh min-h-[32rem] flex-none' : 'flex-1')}
      >
        {header}
        <div
          className={cn(
            'flex w-full min-w-0 flex-col gap-6 p-4 sm:p-6',
            WIDTH[width],
            fill && 'min-h-0 flex-1',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </PageWidthContext.Provider>
  );
}

export function PageHeader({
  title,
  description,
  back,
  badge,
  actions,
  children,
}: {
  title: ReactNode;
  /** One short sentence, on one line under the title (cut short on narrow screens). */
  description?: ReactNode;
  /** A `BackButton` to the page's parent list, before the title. */
  back?: ReactNode;
  /** A status next to the title. */
  badge?: ReactNode;
  /** The page's actions, on the right. */
  actions?: ReactNode;
  /** Between the title and the actions, taking the room left (the library's search). */
  children?: ReactNode;
}) {
  const width = useContext(PageWidthContext);
  return (
    <header className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div
        className={cn(
          'flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6',
          WIDTH[width],
        )}
      >
        {/* On wide screens the sidebar folds from its rail (or Ctrl/Cmd+B). */}
        <SidebarTrigger className="-ml-1 md:hidden" />
        {back}
        <div className={cn('flex min-w-0 flex-col', children ? 'shrink-0' : 'flex-1')}>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-heading text-lg leading-tight font-semibold">{title}</h1>
            {badge}
          </div>
          {description && (
            <p
              className="truncate text-xs text-muted-foreground"
              title={typeof description === 'string' ? description : undefined}
            >
              {description}
            </p>
          )}
        </div>
        {/* On a phone it takes a line of its own, under the title and the actions. */}
        {children && (
          <div className="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
            {children}
          </div>
        )}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** "← All clocks": a page's way back to its list. Pass `nativeButton={false}` and a `render` link. */
export function BackButton({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2" {...props}>
      <ArrowLeftIcon data-icon="inline-start" />
      {/* Just the arrow on a phone, where the title needs the room. */}
      <span className="max-sm:sr-only">{children}</span>
    </Button>
  );
}
