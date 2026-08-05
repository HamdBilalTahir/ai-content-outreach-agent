import { type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// One accordion section inside the single detail sidebar card. An open section
// is sized to its content (capped, then scrolls internally) rather than
// stretching to fill the sidebar; closed ones collapse to just their header.
export function AccordionSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full shrink-0 cursor-pointer items-center justify-between gap-2 border-b border-gray-200 px-4 py-2.5 text-left text-[13px] font-medium transition-colors',
          open
            ? 'bg-gray-50 text-gray-900'
            : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
        )}
      >
        <span className="flex items-center gap-2">
          <span>{title}</span>
          {count != null && count > 0 && (
            <span
              className={cn(
                'inline-flex min-w-4 items-center justify-center rounded px-1 py-0.5 text-[10px] font-semibold',
                open ? 'bg-slate-900 text-white' : 'bg-gray-100 text-gray-500'
              )}
            >
              {count}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-gray-400 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      {/* Content — sized to content; caps and scrolls internally when long */}
      {open && <div className="max-h-[60vh] overflow-auto p-4">{children}</div>}
    </div>
  );
}
