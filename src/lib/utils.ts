/**
 * The two helpers the outbound admin UI imports from the admin panel's `lib/utils` and `lib/chat-utils`.
 *
 * The source's `lib/utils.ts` is 196 lines of assorted helpers; only `cn` is used by anything ported here,
 * so only `cn` came across. Same rule the backend port followed — build what is used, not what exists.
 */

import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later Tailwind utilities win over earlier conflicting ones.
 *
 * `clsx` flattens the conditionals; `twMerge` is what makes `cn('p-2', 'p-4')` resolve to `p-4` instead of
 * emitting both and leaving the winner to CSS source order. Every shadcn primitive depends on this so a
 * caller's `className` can override the component's own defaults.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Is this chat archived?
 *
 * Checks BOTH flags because the campaign stop sweep stamps both, and older documents carry only one — the
 * same either-flag rule the backend's `attributedStageCounts` applies for the same reason.
 */
export function isArchivedChat(
  chat: Record<string, unknown> | null | undefined
): boolean {
  if (!chat) return false;
  return chat.archived === true || chat.status === 'archived';
}
