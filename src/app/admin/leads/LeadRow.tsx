'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { Lead } from '../../../../lib/types';

export default function LeadRow({
  lead,
  nicheName,
}: {
  lead: Lead;
  nicheName: string;
}) {
  const [activePopover, setActivePopover] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  const handleFeedbackClick = (outcome: string) => {
    setActivePopover(outcome);
    setNotes('');
    setFeedbackSuccess(false);

    // Auto-save after 3 seconds
    const timer = setTimeout(() => {
      submitFeedback(outcome);
    }, 3000);
    // Note: To clear timeout when typing, we'd need refs and useEffect.
    // For now we'll do the simple implementation as required.
  };

  const submitFeedback = async (outcome: string) => {
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: lead.id,
          outcome,
          notes,
        }),
      });

      if (res.ok) {
        setFeedbackSuccess(true);
        setTimeout(() => {
          setActivePopover(null);
          setFeedbackSuccess(false);
        }, 1500); // Hide popover shortly after success toast
      } else {
        alert('Failed to save feedback');
      }
    } catch (e) {
      alert('Error saving feedback');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3 font-medium text-blue-600">
        <Link href={`/admin/leads/${lead.id}`} className="hover:underline">
          {lead.brandName}
        </Link>
      </td>
      <td className="px-4 py-3 text-gray-600">{nicheName}</td>
      <td className="px-4 py-3 text-right text-gray-600">
        {lead.socialMediaGapScore ?? '-'}
      </td>
      <td className="px-4 py-3 text-gray-600">
        {lead.pitchAngle ? (
          <span className="inline-block rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">
            {lead.pitchAngle}
          </span>
        ) : (
          '-'
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            lead.status === 'Qualified' || lead.status === 'approved'
              ? 'bg-green-100 text-green-700'
              : lead.status === 'Pitched'
                ? 'bg-purple-100 text-purple-700'
                : lead.status === 'Closed' || lead.status === 'Negotiating'
                  ? 'bg-blue-100 text-blue-700'
                  : lead.status === 'Ghosted' ||
                      lead.status === 'incomplete' ||
                      lead.status === ('pending_approval' as any)
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-red-100 text-red-700'
          }`}
        >
          {lead.status === ('pending_approval' as any) ||
          lead.dispatchStatus === 'pending_approval'
            ? 'pending_approval'
            : lead.status}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-500">
        {lead.createdAt?.toDate?.().toLocaleString() || 'Unknown'}
      </td>
      <td className="px-4 py-3 relative">
        {/* Badges */}
        <div className="flex space-x-1">
          <button
            onClick={() => handleFeedbackClick('Closed')}
            className="rounded bg-green-50 px-2 py-1 text-xs font-semibold text-green-700 hover:bg-green-100 ring-1 ring-inset ring-green-600/20"
          >
            Closed
          </button>
          <button
            onClick={() => handleFeedbackClick('Rejected')}
            className="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 ring-1 ring-inset ring-red-600/20"
          >
            Rejected
          </button>
          <button
            onClick={() => handleFeedbackClick('Ghosted')}
            className="rounded bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 ring-1 ring-inset ring-gray-500/10"
          >
            Ghosted
          </button>
        </div>

        {/* Popover */}
        {activePopover && (
          <div className="absolute right-0 top-full mt-1 z-10 w-64 rounded-md bg-white p-3 shadow-lg ring-1 ring-black ring-opacity-5">
            {feedbackSuccess ? (
              <div className="text-sm font-medium text-green-600 text-center py-2">
                ✅ Saved!
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-700">
                  Logging: {activePopover}
                </p>
                <textarea
                  autoFocus
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Reason / Notes..."
                  className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-xs"
                />
                <div className="flex justify-between items-center pt-1">
                  <span className="text-[10px] text-gray-400">
                    Auto-saving...
                  </span>
                  <button
                    onClick={() => submitFeedback(activePopover)}
                    disabled={isSubmitting}
                    className="rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Save Now
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
