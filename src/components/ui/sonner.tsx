'use client';

/**
 * The toast host. **Must be mounted or every `toast()` call is silently a no-op** — which is how a ported
 * page ends up looking like its save button does nothing.
 *
 * Ported from the admin panel's `components/ui/sonner.tsx` minus its `useTheme()` call: that comes from
 * `next-themes`, which this repo does not have and does not need — there is no theme switcher here. The
 * `toastOptions` class map is the part that matters and is carried across unchanged, so toasts pick up the
 * shadcn surface tokens rather than sonner's own defaults.
 */

// Explicit, because the source leans on the ambient `React` namespace for the prop type and this repo's
// eslint flags that as `no-undef`.
import type * as React from 'react';
import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
