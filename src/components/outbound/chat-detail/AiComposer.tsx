'use client';

import { useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { useComposerHistory } from './useComposerHistory';

// Highlight "@AI" in composer text. Keeps the SAME font weight/metrics so the
// transparent textarea on top stays pixel-aligned with this backdrop — only the
// background + text color change (no layout shift).
function highlightAiInput(text: string): ReactNode {
  if (!text) return null;
  return text.split(/(@ai)/gi).map((part, i) =>
    /^@ai$/i.test(part) ? (
      // Same purple chip as the conversation @AI mention. px-1 widens the
      // background like the bubble; -mx-1 cancels its layout effect so the
      // transparent textarea on top stays pixel-aligned.
      <span
        key={i}
        className="-mx-1 rounded bg-purple-200 px-1 text-purple-800"
      >
        {part}
      </span>
    ) : (
      part
    )
  );
}

// Composer pinned to the bottom of the conversation: send an "@AI …" trigger
// message into the active chat (prefix added server-side if omitted).
export function AiComposer({
  chatId,
  onSent,
}: {
  chatId: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const history = useComposerHistory();

  const send = async () => {
    const msg = text.trim();
    if (!msg || !chatId || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/outbound/trigger-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: msg }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }
      history.record(msg);
      setText('');
      onSent();
    } catch (e: any) {
      setError(e?.message || 'Failed to send the trigger.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-gray-100 p-3">
      {error && <p className="mb-1.5 text-[11px] text-red-600">{error}</p>}
      <div className="flex items-end gap-2">
        <div className="relative min-h-[40px] flex-1">
          {/* Highlight overlay: shows typed text with @AI marked as an admin
              command. The textarea on top has transparent text so this shows
              through; box metrics are kept identical for exact alignment. */}
          <div
            ref={backdropRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 max-h-32 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-transparent px-3.5 py-2.5 text-[13px] leading-5 text-gray-800"
          >
            {highlightAiInput(text)}
          </div>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              history.resetNav();
              // Auto-space a leading "@ai" trigger so the next word is separated
              // (anchored to the start so mid-text emails like x@ai.com are safe).
              setText(e.target.value.replace(/^(@ai)(?=\S)/i, '$1 '));
            }}
            onScroll={() => {
              if (backdropRef.current && taRef.current)
                backdropRef.current.scrollTop = taRef.current.scrollTop;
            }}
            onKeyDown={(e) => {
              // ArrowUp/Down recall previously sent messages (shell-style).
              if (history.onKeyDown(e, text, setText)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              chatId ? 'Send an @AI trigger message…' : 'No active chat'
            }
            disabled={!chatId || sending}
            className="relative max-h-32 min-h-[40px] w-full resize-none rounded-xl border border-gray-200 bg-transparent px-3.5 py-2.5 text-[13px] leading-5 text-transparent caret-gray-800 placeholder-gray-400 transition-colors focus:border-slate-700 focus:outline-none focus:ring-4 focus:ring-slate-700/10 disabled:bg-gray-50"
          />
        </div>
        <button
          type="button"
          onClick={send}
          disabled={!chatId || sending || !text.trim()}
          className="flex h-[40px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          Send
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-gray-400">
        Prefixed with <span className="font-mono text-gray-500">@AI</span>{' '}
        automatically · Enter to send, Shift+Enter for a new line.
      </p>
    </div>
  );
}
