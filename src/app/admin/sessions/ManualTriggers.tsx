'use client';

import React, { useState, useEffect } from 'react';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../../../../lib/firebase/client';
import type { CrawlSession } from '../../../../lib/types';

import {
  collection,
  query,
  where,
  onSnapshot as firestoreOnSnapshot,
} from 'firebase/firestore';

export default function ManualTriggers({
  niches,
}: {
  niches: { id: string; name: string }[];
}) {
  const [forceNicheId, setForceNicheId] = useState<string>('');
  const [maxTargets, setMaxTargets] = useState<number>(5);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<string>('idle');
  const [loading, setLoading] = useState(false);
  const [qualifiedLeads, setQualifiedLeads] = useState<any[]>([]);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const logsEndRef = React.useRef<HTMLDivElement>(null);

  // Setup Modal State
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [pipelineName, setPipelineName] = useState('');
  const [pipelineDesc, setPipelineDesc] = useState('');

  // Modals
  const [showPlaybookModal, setShowPlaybookModal] = useState(false);
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  const [showInspectorModal, setShowInspectorModal] = useState(false);
  const [inspectingLead, setInspectingLead] = useState<any | null>(null);
  const [editedPitch, setEditedPitch] = useState('');

  // We change state to handle AgentLog[] instead of string[]
  const [agentLogs, setAgentLogs] = useState<any[]>([]);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentLogs]);

  useEffect(() => {
    if (!sessionId) return;

    let sessionRef: any;
    if (sessionId.startsWith('sandbox:')) {
      const [, pId, rId] = sessionId.split(':');
      sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
    } else {
      sessionRef = doc(db, 'crawlSessions', sessionId);
    }

    const unsubSession = onSnapshot(sessionRef, (docSnap: any) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as CrawlSession;
        setAgentLogs(data.agentLogs || []);
        setStatus(data.sessionStatus || 'idle');
      }
    });

    let leadsQueryRef: any;
    if (sessionId.startsWith('sandbox:')) {
      const [, pId, rId] = sessionId.split(':');
      leadsQueryRef = collection(
        db,
        'pipelines',
        pId,
        'sandbox_runs',
        rId,
        'sandbox_candidates'
      );
    } else {
      leadsQueryRef = query(
        collection(db, 'leads'),
        where('crawlSessionId', '==', sessionId)
      );
    }

    const unsubLeads = firestoreOnSnapshot(leadsQueryRef, (snapshot: any) => {
      const leads = snapshot.docs.map((d: any) => {
        let finalId = d.id;
        if (sessionId.startsWith('sandbox:')) {
          const [, pId, rId] = sessionId.split(':');
          finalId = `sandbox_candidate:${pId}:${rId}:${d.id}`;
        }
        return { id: finalId, ...d.data() };
      });
      setQualifiedLeads(leads.filter((l: any) => l.status === 'Qualified'));
    });

    return () => {
      unsubSession();
      unsubLeads();
    };
  }, [sessionId]);

  const handleStartClick = () => {
    setShowSetupModal(true);
  };

  const submitSetup = async () => {
    if (!pipelineName) return alert('Pipeline Name required');
    setShowSetupModal(false);
    setLoading(true);
    setAgentLogs([]);
    setQualifiedLeads([]);
    setSelectedLeads(new Set());
    setStatus('Starting...');
    try {
      // 1. Create pipeline
      const pRes = await fetch('/api/admin/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pipelineName,
          description: pipelineDesc,
          status: 'paused',
        }),
      });
      const pData = await pRes.json();
      const pId = pData.id;
      setActivePipelineId(pId);

      // 2. Run crawl
      const res = await fetch('/api/admin/run-crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forceNicheId: forceNicheId || undefined,
          maxTargets,
          isSandbox: true,
          pipelineId: pId,
        }),
      });
      const data = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
      } else {
        alert(data.message || data.error || 'Failed to start');
        setStatus('Failed');
      }
    } catch (e) {
      alert('Request failed');
      setStatus('Failed');
    }
    setLoading(false);
  };

  const handleStop = async () => {
    if (!sessionId) return;
    try {
      let sessionRef: any;
      if (sessionId.startsWith('sandbox:')) {
        const [, pId, rId] = sessionId.split(':');
        sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
      } else {
        sessionRef = doc(db, 'crawlSessions', sessionId);
      }
      await updateDoc(sessionRef, {
        sessionStatus: 'Stopped',
      });
      setStatus('Stopped');
    } catch (e) {
      alert('Failed to stop session');
    }
  };

  const handleManualDispatch = async () => {
    if (selectedLeads.size === 0) return;
    setDispatching(true);
    try {
      const res = await fetch('/api/admin/dispatch-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: Array.from(selectedLeads) }),
      });
      const data = await res.json();
      alert(
        data.message ||
          (data.success ? 'Dispatch triggered!' : 'Dispatch failed')
      );
      if (data.success) {
        setSelectedLeads(new Set());
      }
    } catch (e) {
      alert('Dispatch request failed');
    }
    setDispatching(false);
  };

  const isRunning = status === 'Running' || status === 'Starting...';

  const fetchPlaybooks = async () => {
    if (!activePipelineId) return alert('No active pipeline ID');
    setShowPlaybookModal(true);
    try {
      const q = query(
        collection(db, 'intelligence'),
        where('pipelineId', '==', activePipelineId)
      );
      const pSnapshot = await firestoreOnSnapshot(q, (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setPlaybooks(data);
      });
    } catch (e) {
      console.error(e);
    }
  };

  const openInspector = (lead: any) => {
    setInspectingLead(lead);
    setEditedPitch(lead.generatedPitch || '');
    setShowInspectorModal(true);
  };

  const saveInspectorDraft = async () => {
    if (!inspectingLead) return;
    try {
      const updates: any = { generatedPitch: editedPitch };
      if (!inspectingLead.originalGeneratedPitch) {
        updates.originalGeneratedPitch = inspectingLead.generatedPitch;
      }

      let ref: any;
      if (inspectingLead.id.startsWith('sandbox_candidate:')) {
        const [, pId, rId, cId] = inspectingLead.id.split(':');
        ref = doc(
          db,
          'pipelines',
          pId,
          'sandbox_runs',
          rId,
          'sandbox_candidates',
          cId
        );
      } else {
        ref = doc(db, 'leads', inspectingLead.id);
      }

      await updateDoc(ref, updates);
      setShowInspectorModal(false);
    } catch (e) {
      alert('Failed to save draft');
    }
  };

  const handleRejectLead = async (leadId: string) => {
    try {
      let ref: any;
      if (leadId.startsWith('sandbox_candidate:')) {
        const [, pId, rId, cId] = leadId.split(':');
        ref = doc(
          db,
          'pipelines',
          pId,
          'sandbox_runs',
          rId,
          'sandbox_candidates',
          cId
        );
      } else {
        ref = doc(db, 'leads', leadId);
      }

      await updateDoc(ref, {
        status: 'Failed',
        sandboxRejected: true,
      });
      // Removing from selection if it was selected
      const newSet = new Set(selectedLeads);
      if (newSet.has(leadId)) {
        newSet.delete(leadId);
        setSelectedLeads(newSet);
      }
    } catch (e) {
      alert('Failed to reject lead');
    }
  };

  const handleStopAndSynthesize = async () => {
    if (!sessionId || !activePipelineId) return;
    setSynthesizing(true);
    setStatus('Synthesizing...');
    try {
      // Stop session
      let sessionRef: any;
      if (sessionId.startsWith('sandbox:')) {
        const [, pId, rId] = sessionId.split(':');
        sessionRef = doc(db, 'pipelines', pId, 'sandbox_runs', rId);
      } else {
        sessionRef = doc(db, 'crawlSessions', sessionId);
      }
      await updateDoc(sessionRef, {
        sessionStatus: 'Stopped',
      });

      // Trigger synthesis
      const res = await fetch('/api/admin/synthesize-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: activePipelineId,
          runId: sessionId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('✅ Sandbox Ended. Playbooks successfully updated.');
      } else {
        setStatus('Failed to synthesize.');
      }
    } catch (e) {
      setStatus('Failed to synthesize.');
    }
    setSynthesizing(false);
  };

  return (
    <div className="space-y-6 relative">
      {showSetupModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full space-y-4">
            <h3 className="text-lg font-bold">New Sandbox Run</h3>
            <div>
              <label className="block text-sm font-medium mb-1">
                Pipeline Name
              </label>
              <input
                value={pipelineName}
                onChange={(e) => setPipelineName(e.target.value)}
                className="w-full border rounded p-2"
                placeholder="e.g. Texas Roofers Q3"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Description / Goal
              </label>
              <textarea
                value={pipelineDesc}
                onChange={(e) => setPipelineDesc(e.target.value)}
                className="w-full border rounded p-2"
                placeholder="Testing aggressive hooks..."
              ></textarea>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSetupModal(false)}
                className="px-4 py-2 border rounded text-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={submitSetup}
                className="px-4 py-2 bg-indigo-600 text-white rounded"
              >
                Create & Start
              </button>
            </div>
          </div>
        </div>
      )}

      {showPlaybookModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-3xl w-full h-[80vh] flex flex-col space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">
                Active Playbooks (Pipeline {activePipelineId})
              </h3>
              <button
                onClick={() => setShowPlaybookModal(false)}
                className="text-gray-500 hover:text-black"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto space-y-6">
              {playbooks.length === 0 ? (
                <p className="text-gray-500">No playbooks found yet.</p>
              ) : (
                playbooks.map((pb) => (
                  <div key={pb.id} className="border p-4 rounded bg-gray-50">
                    <h4 className="font-bold text-sm text-indigo-600 mb-2">
                      Role: {pb.agentRole} (v{pb.version})
                    </h4>
                    <a
                      href={pb.blobUrl}
                      target="_blank"
                      className="text-blue-500 text-xs hover:underline"
                    >
                      View File
                    </a>
                    {/* Skipping full ReactMarkdown setup for minimal requirements, providing a link to raw file instead or rendering raw */}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showInspectorModal && inspectingLead && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">Inspect & Override Draft</h3>
              <button
                onClick={() => setShowInspectorModal(false)}
                className="text-gray-500 hover:text-black"
              >
                ✕
              </button>
            </div>
            <div>
              <p className="text-sm text-gray-500 mb-2">
                Lead:{' '}
                <span className="font-semibold">
                  {inspectingLead.brandName}
                </span>
              </p>
              <textarea
                value={editedPitch}
                onChange={(e) => setEditedPitch(e.target.value)}
                className="w-full border rounded p-3 h-64 font-mono text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowInspectorModal(false)}
                className="px-4 py-2 border rounded text-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={saveInspectorDraft}
                className="px-4 py-2 bg-indigo-600 text-white rounded"
              >
                Save Draft
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Live Sandbox Diagnostics
            </h2>
            <p className="text-sm text-gray-500">
              Test the AI's decision making process in real-time.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="w-64">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Force Target Niche (Optional)
            </label>
            <select
              value={forceNicheId}
              onChange={(e) => setForceNicheId(e.target.value)}
              disabled={isRunning || loading}
              className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
            >
              <option value="">-- Let AI Decide --</option>
              {niches.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>

          <div className="w-32">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Max Targets
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={maxTargets}
              onChange={(e) => setMaxTargets(Number(e.target.value))}
              disabled={isRunning || loading}
              className="mt-1 block w-full rounded-md border border-gray-300 py-2 px-3 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
            />
          </div>

          {!isRunning ? (
            <button
              onClick={handleStartClick}
              disabled={loading}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 h-10"
            >
              {loading ? 'Starting...' : 'Start New Sandbox Run'}
            </button>
          ) : (
            <button
              onClick={handleStopAndSynthesize}
              disabled={synthesizing}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 h-10 disabled:opacity-50"
            >
              {synthesizing
                ? 'AI is reviewing your actions and updating Playbooks...'
                : '⏹️ Stop Sandbox & Synthesize'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-gray-800 bg-gray-900 shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
            <div className="flex space-x-2">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
            </div>
            <div className="flex gap-4 items-center">
              <button
                onClick={fetchPlaybooks}
                disabled={!activePipelineId}
                className="text-xs text-indigo-300 hover:text-indigo-200 bg-gray-700 px-2 py-1 rounded"
              >
                📚 View Active Playbooks
              </button>
              <span className="text-xs text-gray-400 font-mono">
                Status: {status}
              </span>
            </div>
          </div>
          <div className="p-4 flex-1 overflow-y-auto font-mono text-sm flex flex-col justify-start">
            {agentLogs.length === 0 ? (
              <div className="text-gray-500 italic">Waiting for agents...</div>
            ) : (
              <div className="space-y-3">
                {agentLogs.map((log, i) => {
                  let avatar = '🤖';
                  let name = 'System';
                  let colorClass = 'text-gray-400';

                  switch (log.agentRole) {
                    case 'strategist':
                      avatar = '🧭';
                      name = 'The Strategist';
                      colorClass = 'text-blue-400';
                      break;
                    case 'scraper':
                      avatar = '🕸️';
                      name = 'The Web Scraper';
                      colorClass = 'text-gray-300';
                      break;
                    case 'auditor':
                      avatar = '🕵️';
                      name = 'The Social Auditor';
                      colorClass = 'text-green-400';
                      break;
                    case 'analyst':
                      avatar = '🧠';
                      name = 'Lead Analyst';
                      colorClass = 'text-purple-400';
                      break;
                    case 'copywriter':
                      avatar = '✍️';
                      name = 'The Copywriter';
                      colorClass = 'text-yellow-400';
                      break;
                  }

                  return (
                    <div key={i} className="flex space-x-2">
                      <span className="text-lg leading-none">{avatar}</span>
                      <div className="flex-1">
                        <div className={`font-bold ${colorClass}`}>{name}</div>
                        <div className="text-gray-300 mt-1">
                          {log.narrative}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-gray-50 shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="px-4 py-3 bg-white border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Sandbox Review Tray</h3>
            <p className="text-xs text-gray-500">
              Select drafted pitches to approve and dispatch
            </p>
          </div>
          <div className="p-4 flex-1 overflow-y-auto space-y-4">
            {qualifiedLeads.length === 0 ? (
              <div className="text-sm text-gray-500 text-center mt-10">
                No leads drafted yet.
              </div>
            ) : (
              qualifiedLeads.map((lead) => (
                <div
                  key={lead.id}
                  className="bg-white p-4 rounded border shadow-sm space-y-2 relative flex gap-3"
                >
                  <div className="pt-1">
                    <input
                      type="checkbox"
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                      checked={selectedLeads.has(lead.id)}
                      onChange={(e) => {
                        const newSet = new Set(selectedLeads);
                        if (e.target.checked) newSet.add(lead.id);
                        else newSet.delete(lead.id);
                        setSelectedLeads(newSet);
                      }}
                    />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="absolute top-2 right-2 bg-indigo-100 text-indigo-800 text-xs px-2 py-1 rounded font-semibold">
                      Score: {lead.socialMediaGapScore}/10
                    </div>
                    <h4 className="font-bold text-gray-900 truncate pr-24">
                      {lead.brandName}
                    </h4>
                    <p className="text-xs text-gray-500">{lead.websiteUrl}</p>
                    <div className="mt-2 bg-gray-100 p-3 rounded text-sm text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto relative">
                      <span className="font-semibold block mb-1">
                        ✍️ Pitch Draft ({lead.pitchAngle}):
                      </span>
                      {lead.generatedPitch}
                      <div className="absolute top-2 right-2 flex gap-2">
                        <button
                          onClick={() => handleRejectLead(lead.id)}
                          className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded hover:bg-red-200"
                        >
                          🗑️ Reject
                        </button>
                        <button
                          onClick={() => openInspector(lead)}
                          className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded hover:bg-indigo-200"
                        >
                          🔍 Inspect
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="px-4 py-3 bg-white border-t border-gray-200">
            <button
              onClick={handleManualDispatch}
              disabled={selectedLeads.size === 0 || dispatching}
              className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {dispatching
                ? 'Dispatching...'
                : `Dispatch Selected Leads (${selectedLeads.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
