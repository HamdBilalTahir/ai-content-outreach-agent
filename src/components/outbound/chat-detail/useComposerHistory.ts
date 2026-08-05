'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';

// Shell-style composer history: recall previously sent messages with ArrowUp
// (older) / ArrowDown (newer). Shared by the campaign-inbox and E2E composers.
// History is persisted in localStorage so it survives reloads; @AI triggers are
// reused across chats, so a single shared list is intentional.
const KEY = 'outbound-ai-composer:history';
const LIMIT = 30;

function caretToEnd(el: HTMLTextAreaElement) {
  requestAnimationFrame(() => {
    try {
      el.selectionStart = el.selectionEnd = el.value.length;
    } catch {
      /* element may have unmounted */
    }
  });
}

export function useComposerHistory() {
  const historyRef = useRef<string[]>([]); // oldest → newest
  const posRef = useRef<number | null>(null); // null = not navigating (at draft)
  const draftRef = useRef('');

  useEffect(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(arr))
        historyRef.current = arr.filter((x: unknown) => typeof x === 'string');
    } catch {
      /* ignore malformed / unavailable storage */
    }
  }, []);

  // Record a sent message (call after a successful send).
  const record = (msg: string) => {
    const v = msg.trim();
    posRef.current = null;
    draftRef.current = '';
    if (!v) return;
    const h = historyRef.current;
    if (h[h.length - 1] === v) return; // skip consecutive duplicate
    h.push(v);
    if (h.length > LIMIT) h.splice(0, h.length - LIMIT);
    try {
      localStorage.setItem(KEY, JSON.stringify(h));
    } catch {
      /* ignore quota / unavailable storage */
    }
  };

  // Handle ArrowUp/ArrowDown. Returns true if it consumed the key (the caller
  // should then skip its own handling, e.g. Enter-to-send).
  const onKeyDown = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    text: string,
    setText: (v: string) => void
  ): boolean => {
    const el = e.currentTarget;
    const h = historyRef.current;

    if (e.key === 'ArrowUp') {
      // Only when the caret is on the first line — otherwise let the arrow move
      // the caret within a multi-line draft.
      if (el.value.slice(0, el.selectionStart).includes('\n')) return false;
      if (h.length === 0) return false;
      e.preventDefault();
      if (posRef.current === null) {
        draftRef.current = text;
        posRef.current = h.length - 1;
      } else if (posRef.current > 0) {
        posRef.current -= 1;
      }
      setText(h[posRef.current]);
      caretToEnd(el);
      return true;
    }

    if (e.key === 'ArrowDown') {
      if (posRef.current === null) return false; // not navigating
      if (el.value.slice(el.selectionStart).includes('\n')) return false;
      e.preventDefault();
      if (posRef.current < h.length - 1) {
        posRef.current += 1;
        setText(h[posRef.current]);
      } else {
        // Past the newest entry → restore the in-progress draft and exit.
        posRef.current = null;
        setText(draftRef.current);
      }
      caretToEnd(el);
      return true;
    }

    return false;
  };

  // Call from the textarea's onChange so typing exits history navigation.
  const resetNav = () => {
    posRef.current = null;
  };

  return { record, onKeyDown, resetNav };
}
