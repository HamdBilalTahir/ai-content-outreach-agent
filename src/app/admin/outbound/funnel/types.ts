// Deal-funnel API contract (GET /outbound_agent/analytics/deal-funnel/).
export type StageType = 'open' | 'won' | 'lost';

export interface FunnelStage {
  id: string;
  label: string;
  order: number;
  type: StageType;
  is_entry: boolean;
  count: number;
}

export interface DealFunnelResponse {
  pipeline_id: string;
  pipeline_label: string;
  filters: Record<string, string | null>;
  stages: FunnelStage[];
  total: number;
}
