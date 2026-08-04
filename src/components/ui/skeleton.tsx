// The source leans on the ambient `React` namespace for the prop type; this repo's eslint config flags
// that as `no-undef`, so the type is imported explicitly. Same fix wherever it recurs in a ported file.
import type * as React from 'react';

import { cn } from '@/lib/utils';

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-primary/10', className)}
      {...props}
    />
  );
}

export { Skeleton };
