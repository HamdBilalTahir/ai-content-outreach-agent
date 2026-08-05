'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Phone, RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTranscriptTurns, humanize, mmss } from './helpers';

// Popup with the call transcript: the live turn-by-turn conversation (fetched
// from /api/voice-workers/transcript by call_id) plus the structured
// review_call_transcript result (summary, confirmed fields, changes, quotes).
export function CallTranscriptModal({
  transcript,
  recordingUrl,
  callId,
  onClose,
}: {
  transcript?: any;
  recordingUrl?: string;
  callId?: string;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<any[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsError, setTurnsError] = useState<string | null>(null);
  const [apiSummary, setApiSummary] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    setTurnsLoading(true);
    setTurnsError(null);
    fetch(`/api/voice-workers/transcript?call_id=${encodeURIComponent(callId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load the live transcript.');
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setTurns(Array.isArray(data?.transcript) ? data.transcript : []);
        setApiSummary(typeof data?.summary === 'string' ? data.summary : '');
      })
      .catch((e) => {
        if (!cancelled)
          setTurnsError(e?.message || 'Failed to load transcript.');
      })
      .finally(() => {
        if (!cancelled) setTurnsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const t = transcript || {};
  const summary = apiSummary || t.summary || t.transcript_summary || '';
  const messages = turns.filter((turn) => (turn?.message ?? '').trim());
  const confirmed =
    t.confirmed_in_this_call && typeof t.confirmed_in_this_call === 'object'
      ? Object.entries(t.confirmed_in_this_call)
      : [];
  const changes = Array.isArray(t.memory_changes) ? t.memory_changes : [];
  const quotes =
    t.quotes && typeof t.quotes === 'object' ? Object.entries(t.quotes) : [];
  const empty =
    !summary &&
    messages.length === 0 &&
    confirmed.length === 0 &&
    changes.length === 0 &&
    !recordingUrl;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Phone className="size-4 text-teal-600" />
            <h3 className="text-sm font-semibold text-gray-900">
              Call transcript
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(formatTranscriptTurns(messages))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => {});
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium',
                  copied
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                )}
              >
                {copied ? (
                  <>
                    <Check className="size-3.5 text-emerald-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" /> Copy
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="space-y-4 px-5 py-4 text-[12px] text-gray-700">
          {recordingUrl && (
            <a
              href={recordingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:text-slate-700"
            >
              ▶ Play recording
            </a>
          )}
          {summary && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Summary
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{summary}</p>
            </div>
          )}
          {callId && (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Transcript
              </div>
              {turnsLoading ? (
                <div className="flex items-center gap-2 py-3 text-gray-400">
                  <RefreshCw className="size-3.5 animate-spin" /> Loading
                  transcript…
                </div>
              ) : turnsError ? (
                <p className="py-2 text-rose-600">{turnsError}</p>
              ) : messages.length === 0 ? (
                <p className="py-2 text-gray-400">
                  No transcript turns available for this call yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {messages.map((turn, i) => {
                    const isAgent = turn.role === 'agent';
                    return (
                      <div
                        key={i}
                        className={cn(
                          'max-w-[88%] rounded-xl px-3 py-1.5',
                          isAgent
                            ? 'mr-auto bg-gray-100 text-gray-700'
                            : 'ml-auto bg-slate-100 text-slate-900'
                        )}
                      >
                        <div className="mb-0.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
                          <span
                            className={
                              isAgent ? 'text-gray-500' : 'text-slate-900'
                            }
                          >
                            {isAgent ? 'Agent' : 'User'}
                          </span>
                          {turn.time_in_call_secs != null && (
                            <span className="text-gray-400">
                              {mmss(turn.time_in_call_secs)}
                            </span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {turn.message}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {confirmed.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Confirmed in this call
              </div>
              <div className="space-y-1">
                {confirmed.map(([k, val]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <span className="text-gray-400">{humanize(k)}</span>
                    <span className="text-right font-medium text-gray-700">
                      {String(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {changes.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Memory changes
              </div>
              <ul className="list-disc space-y-0.5 pl-4">
                {changes.map((c: any, i: number) => (
                  <li key={i}>{String(c)}</li>
                ))}
              </ul>
            </div>
          )}
          {quotes.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Quotes
              </div>
              <div className="space-y-1">
                {quotes.map(([k, val]) => (
                  <p key={k} className="italic">
                    “{String(val)}”{' '}
                    <span className="not-italic text-gray-400">
                      — {humanize(k)}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          )}
          {empty && (
            <p className="text-gray-400">
              No transcript details captured for this call.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
