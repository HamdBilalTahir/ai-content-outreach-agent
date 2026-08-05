'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Render an email body nicely: the new reply on top, and the quoted reply-chain
// (the "On … wrote:" attribution + ">"-prefixed lines) collapsed behind a
// Gmail-style toggle, shown as a muted blockquote with the ">" markers stripped.
export function EmailBody({ body }: { body: string }) {
  const lines = body.split('\n');
  // Quote starts at the attribution line ("On … wrote:") or the first ">" line.
  let idx = lines.findIndex((l) => /\bwrote:\s*$/i.test(l.trim()));
  if (idx === -1) idx = lines.findIndex((l) => /^\s*>/.test(l));
  const reply = (idx === -1 ? body : lines.slice(0, idx).join('\n')).trim();
  const quoted = idx === -1 ? '' : lines.slice(idx).join('\n').trim();
  return (
    <div className="mt-1 min-w-0 space-y-1.5">
      {reply && (
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12px] leading-relaxed text-gray-700">
          {reply}
        </p>
      )}
      {quoted && <EmailQuote text={quoted} />}
    </div>
  );
}

export function EmailQuote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clean = text
    .split('\n')
    .map((l) => l.replace(/^\s*>+\s?/, ''))
    .join('\n')
    .trim();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 transition-colors hover:bg-gray-100"
      >
        <ChevronDown
          className={cn('size-3 transition-transform', open && 'rotate-180')}
        />
        {open ? 'Hide quoted text' : 'Show quoted text'}
      </button>
      {open && (
        <div className="mt-1.5 min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border-l-2 border-slate-300 bg-slate-100/80 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-500">
          {clean}
        </div>
      )}
    </div>
  );
}
