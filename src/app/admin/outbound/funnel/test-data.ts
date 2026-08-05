import type { DealFunnelResponse } from './types';

// Plug-and-play preview data for the funnel dashboard.
// Flip USE_TEST_DATA to `false` for live data — when `true`, the dashboard
// renders these representative numbers and skips the Firestore + API calls.
// ⚠️ Must be `false` in production, or the funnel shows fake data.
export const USE_TEST_DATA = false;

export const TEST_FIRESTORE = { new: 1240, contacted: 620, engaged: 310 };

export const TEST_DEAL: DealFunnelResponse = {
  pipeline_id: '123',
  pipeline_label: 'Ava Sales Pipeline',
  filters: {},
  total: 255,
  stages: [
    {
      id: 's1',
      label: 'Initial Demo Scheduled',
      order: 0,
      type: 'open',
      is_entry: true,
      count: 120,
    },
    {
      id: 's2',
      label: 'Demo Completed',
      order: 1,
      type: 'open',
      is_entry: false,
      count: 40,
    },
    {
      id: 's3',
      label: 'Proposal Sent',
      order: 2,
      type: 'open',
      is_entry: false,
      count: 15,
    },
    {
      id: 's4',
      label: 'Negotiation',
      order: 3,
      type: 'open',
      is_entry: false,
      count: 10,
    },
    {
      id: 's5',
      label: 'Closed Won',
      order: 4,
      type: 'won',
      is_entry: false,
      count: 28,
    },
    {
      id: 's6',
      label: 'Closed Lost',
      order: 5,
      type: 'lost',
      is_entry: false,
      count: 42,
    },
  ],
};
