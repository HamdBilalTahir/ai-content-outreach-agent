'use client';

/**
 * The shadcn Checkbox, reimplemented on a native `<input type="checkbox">` instead of
 * `@radix-ui/react-checkbox`.
 *
 * The ported UI uses exactly two checkboxes — the phone and email opt-out toggles in `ChatDetailView` —
 * and both are plain controlled booleans. A Radix dependency for that is not worth it, so this keeps
 * Radix's **prop contract** (`checked`, `onCheckedChange`) and its **styling contract** (a `data-state`
 * attribute of `checked`/`unchecked`) while dropping the package.
 *
 * Both contracts matter. The call sites pass `onCheckedChange` and style with
 * `data-[state=checked]:bg-rose-500`, so preserving those two things is what lets them stay
 * byte-identical to the source — which is the point of a UI port whose only evidence is the diff.
 *
 * What is genuinely lost: Radix's indeterminate state and its `asChild` composition. Neither is used
 * here, and `tsc` will say so the moment someone reaches for them.
 */

import * as React from 'react';
import { CheckIcon } from '@radix-ui/react-icons';

import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<
  React.ComponentPropsWithoutRef<'input'>,
  'onChange' | 'type'
> {
  /** Radix's callback name, kept so the call sites need no edit. */
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    const state = checked ? 'checked' : 'unchecked';
    return (
      <span className="relative inline-flex shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
          data-state={state}
          className={cn(
            'peer size-4 shrink-0 appearance-none rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
            className
          )}
          {...props}
        />
        {/*
          Radix renders the tick inside an Indicator CHILD; a native input cannot have children, so it is
          overlaid and made click-through. `peer-data-[state=checked]` keeps it in step with the input.
        */}
        <CheckIcon
          aria-hidden
          className="pointer-events-none absolute size-3.5 text-primary-foreground opacity-0 peer-data-[state=checked]:opacity-100"
        />
      </span>
    );
  }
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
