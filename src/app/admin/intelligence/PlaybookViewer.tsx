'use client';

import React, { useState } from 'react';

export default function PlaybookViewer({
  playbooks,
}: {
  playbooks: Record<string, string>;
}) {
  const roles = ['strategist', 'copywriter', 'scraper', 'auditor', 'analyst'];
  const [activeTab, setActiveTab] = useState(roles[0]);

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex" aria-label="Tabs">
          {roles.map((role) => (
            <button
              key={role}
              onClick={() => setActiveTab(role)}
              className={`
                w-1/5 py-4 px-1 text-center border-b-2 font-medium text-sm capitalize
                ${
                  activeTab === role
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {role}
            </button>
          ))}
        </nav>
      </div>
      <div className="p-6 bg-gray-50">
        <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 bg-white p-6 rounded border border-gray-200 min-h-[400px]">
          {playbooks[activeTab] || 'No playbook found.'}
        </pre>
      </div>
    </div>
  );
}
