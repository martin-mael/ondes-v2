import type { Show } from '@ondes/shared';

/** A show's name with its colour as a straight strip inside the chip (CLAUDE.md, "Web app"). */
export function ShowChip({ show }: { show: Pick<Show, 'name' | 'colour'> }) {
  return (
    <span className="relative inline-flex max-w-full items-center overflow-hidden rounded-[4px] bg-muted py-0.5 pr-2 pl-3 text-xs">
      {show.colour && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ backgroundColor: show.colour }}
        />
      )}
      <span className="truncate">{show.name}</span>
    </span>
  );
}
