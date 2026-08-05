'use client';

import { useState, type ReactNode } from 'react';
import { Check, Clock, Copy, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from './types';
import { fetchTranscriptText, formatDuration } from './helpers';
import { EmailBody } from './EmailBody';
import { AudioPlayer } from './AudioPlayer';
import { CallTranscriptModal } from './CallTranscriptModal';

// Highlight any "@AI" mention inside a message body with a purple chip.
function highlightMentions(text: string): ReactNode {
  return text.split(/(@ai)/gi).map((part, i) =>
    /^@ai$/i.test(part) ? (
      <span
        key={i}
        className="rounded bg-purple-200 px-1 font-semibold text-purple-800"
      >
        {part}
      </span>
    ) : (
      part
    )
  );
}

// Conversation message rendered as a channel-colored bubble.
export function MessageBubble({
  m,
  transcript,
  recordingUrl: recordingUrlProp,
  durationHint,
}: {
  m: ChatMessage;
  transcript?: any;
  recordingUrl?: string;
  durationHint?: number;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [copiedTx, setCopiedTx] = useState(false);
  const isCall = m.type === 'call';
  const src = (m.source || '').toLowerCase();
  const dir = (m.direction || '').toLowerCase();
  const internal = dir === 'internal';
  const aiText = (m.content?.body || '').trim().toLowerCase();
  const isAi = isCall ? false : aiText.startsWith('@ai');
  const variant =
    isAi || (internal && src === 'virtuans')
      ? 'ai'
      : internal && src === 'web'
        ? 'system'
        : internal
          ? 'internal'
          : isCall
            ? 'call'
            : src === 'email'
              ? 'email'
              : src === 'sms'
                ? 'sms'
                : src === 'whatsapp'
                  ? 'whatsapp'
                  : 'message';
  const VARIANTS: Record<
    string,
    { bubble: string; label: string; name: string }
  > = {
    ai: {
      bubble: 'border-purple-200 bg-purple-50',
      label: 'text-purple-700',
      name: 'AI',
    },
    system: {
      bubble: 'border-amber-200 bg-amber-50',
      label: 'text-amber-700',
      name: 'System',
    },
    internal: {
      bubble: 'border-slate-200 bg-slate-100',
      label: 'text-slate-600',
      name: 'Internal',
    },
    call: {
      bubble: 'border-teal-200 bg-teal-50',
      label: 'text-teal-700',
      name: 'Call',
    },
    email: {
      bubble: 'border-blue-200 bg-blue-50',
      label: 'text-blue-700',
      name: 'Email',
    },
    sms: {
      bubble: 'border-green-200 bg-green-50',
      label: 'text-green-700',
      name: 'SMS',
    },
    whatsapp: {
      bubble: 'border-emerald-200 bg-emerald-50',
      label: 'text-emerald-700',
      name: 'WhatsApp',
    },
    message: {
      bubble: 'border-gray-200 bg-gray-50',
      label: 'text-gray-600',
      name: src ? src.charAt(0).toUpperCase() + src.slice(1) : 'Message',
    },
  };
  const v = VARIANTS[variant];
  const tone = v.bubble;
  const labelTone = v.label;
  const label = v.name;
  const align = internal
    ? 'w-full'
    : dir === 'outbound'
      ? 'ml-auto'
      : 'mr-auto';
  const subject = m.content?.subject;
  // While a call is still in progress the message carries an in-progress marker
  // (e.g. summary/outcome === 'in_progress') rather than a real summary — treat
  // those as "no summary yet" so we never render an in-progress call as done.
  const IN_PROGRESS_MARKERS = [
    'in_progress',
    'in progress',
    'queued',
    'ringing',
    'initiated',
    'dialing',
    'calling',
    'pending',
    'running',
    'started',
  ];
  // The call message itself rarely carries a summary; the real post-call
  // summary comes from the review_call_transcript result (passed as `transcript`).
  const rawCallSummary = isCall
    ? (
        m.content?.summary ||
        transcript?.summary ||
        transcript?.transcript_summary ||
        m.content?.outcome ||
        ''
      )
        .toString()
        .trim()
    : '';
  // The call's own outcome flag (separate from `status`, which is just the
  // message-delivery state and is always "delivered").
  const callOutcome = isCall
    ? (m.content?.outcome || '').toString().trim().toLowerCase()
    : '';
  const callDeferred = isCall && callOutcome === 'deferred';
  // A bare status word ("deferred", "in_progress", …) is not a real summary —
  // don't let it stand in for one (which would make the call look completed).
  const NON_SUMMARY_STATUSES = [...IN_PROGRESS_MARKERS, 'deferred'];
  const realSummary =
    rawCallSummary &&
    !NON_SUMMARY_STATUSES.includes(rawCallSummary.toLowerCase())
      ? rawCallSummary
      : '';
  const body = isCall ? realSummary : m.content?.body || '';
  const duration =
    isCall && m.content?.duration != null
      ? formatDuration(m.content.duration)
      : '';
  const callId = isCall
    ? (m.content?.callId ?? m.content?.call_id ?? m.content?.conversation_id)
    : undefined;
  // An explicit recording url from the tool result / transcript (as opposed to
  // the by-call_id proxy fallback below, which resolves for ANY callId even
  // mid-call).
  const explicitRecording = isCall
    ? recordingUrlProp ||
      m.content?.recordingUrl ||
      m.content?.recording_url ||
      transcript?.recording_url ||
      transcript?.recordingUrl ||
      ''
    : '';
  // A call is only "ready" (show transcript / summary / recording) once its
  // post-call artifacts exist. While none are present it's still in progress —
  // we show a lightweight indicator instead of the completed-call UI.
  const hasTranscriptData =
    isCall &&
    (!!transcript ||
      !!m.content?.transcript_summary ||
      !!m.content?.confirmed_in_this_call);
  const callReady =
    isCall && (hasTranscriptData || !!explicitRecording || !!realSummary);
  // Not-yet-completed call: either deferred (scheduled to retry) or actively
  // dialing/ringing. Both hide the completed-call UI (transcript / recording).
  const callInProgress = isCall && !callReady;
  const callActive = callInProgress && !callDeferred;
  // Recording lives in the tool result (make_phone_call), not the call message.
  // Prefer any explicit URL; otherwise stream the ElevenLabs conversation audio
  // by call_id via our proxy — so a completed call always has a play button.
  // Only used inside the callReady block, so an in-progress call never shows it.
  const recordingUrl = isCall
    ? explicitRecording ||
      (callId
        ? `/api/elevenlabs/conversations/${encodeURIComponent(callId)}/audio`
        : undefined)
    : undefined;
  return (
    <div
      className={cn(
        'max-w-[85%] rounded-2xl border px-3.5 py-2.5',
        tone,
        align
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wide',
            labelTone
          )}
        >
          {label}
          {dir && dir !== 'internal' ? ` · ${dir}` : ''}
          {/* Hide the message-delivery status on a not-yet-completed call —
              the status card below already states where the call stands. */}
          {m.status && !callInProgress ? ` · ${m.status}` : ''}
          {duration ? ` · ${duration}` : ''}
        </span>
        <span className="shrink-0 text-[10px] text-gray-400">
          {m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}
        </span>
      </div>
      {subject && (
        <p className="mt-1 text-[12px] font-medium text-gray-800">{subject}</p>
      )}
      {body &&
        (src === 'email' ? (
          <EmailBody body={body} />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">
            {highlightMentions(body)}
          </p>
        ))}
      {callActive && (
        <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-teal-200 bg-teal-50/70 px-3 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-teal-100">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-teal-400 opacity-75 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2.5 rounded-full bg-teal-500" />
            </span>
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-teal-800">
              Call in progress
            </p>
            <p className="text-[11px] leading-tight text-teal-700/80">
              Transcript &amp; recording will appear once it completes
            </p>
          </div>
        </div>
      )}
      {callDeferred && (
        <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <Clock className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-amber-800">
              Call deferred
            </p>
            <p className="text-[11px] leading-tight text-amber-700/80">
              Scheduled to retry automatically
            </p>
          </div>
        </div>
      )}
      {callReady && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowTranscript(true)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-teal-300 bg-white px-2 py-1 text-[11px] font-semibold text-teal-700 transition-colors hover:bg-teal-100"
            >
              <FileText className="size-3" /> View transcript
            </button>
            {callId && (
              <button
                type="button"
                title="Copy transcript"
                onClick={async () => {
                  try {
                    const text = await fetchTranscriptText(callId);
                    await navigator.clipboard?.writeText(text);
                    setCopiedTx(true);
                    setTimeout(() => setCopiedTx(false), 1500);
                  } catch {
                    /* no transcript to copy */
                  }
                }}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium',
                  copiedTx
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                )}
              >
                {copiedTx ? (
                  <>
                    <Check className="size-3 text-emerald-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> Copy
                  </>
                )}
              </button>
            )}
          </div>
          {recordingUrl && (
            <AudioPlayer
              src={recordingUrl}
              durationHint={m.content?.duration ?? durationHint}
            />
          )}
        </div>
      )}
      {showTranscript && (
        <CallTranscriptModal
          transcript={transcript ?? m.content}
          recordingUrl={recordingUrl}
          callId={callId}
          onClose={() => setShowTranscript(false)}
        />
      )}
    </div>
  );
}
