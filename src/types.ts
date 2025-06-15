export interface AgenticSession {
  session_id: string;
  coordinator_id: string;
  worker_ids: string[];
  shared_context: ContextRef;
  work_units: WorkUnit[];
  discoveries: Discovery[];
  outputs: Record<string, any>;
  status: 'planning' | 'executing' | 'consolidating' | 'complete';
  created_at: number;
  updated_at: number;
  ttl?: number;
}

export interface ContextRef {
  ref_id: string;
  summary: string;
  full_context_key: string;
  version: number;
  token_count: number;
  created_at: number;
}

export interface WorkUnit {
  unit_id: string;
  type: string;
  description: string;
  status: 'available' | 'claimed' | 'in_progress' | 'completed' | 'blocked';
  claimed_by?: string;
  estimated_duration?: number;
  actual_duration?: number;
  dependencies: string[];
  priority: 'low' | 'medium' | 'high';
  result?: any;
  created_at: number;
  updated_at: number;
}

export interface Discovery {
  discovery_id: string;
  session_id: string;
  worker_id: string;
  type: 'function_found' | 'dependency_identified' | 'error_pattern' | 'optimization_opportunity' | 'requirement_clarification';
  data: any;
  affects_workers?: string[];
  timestamp: number;
  version: number;
}

export interface WorkerContext {
  shared_context_ref: string;
  worker_specific: WorkerTask;
  dependencies: string[];
  discoveries_since: number;
}

export interface WorkerTask {
  worker_id: string;
  assigned_units: string[];
  specialization?: string;
  context_summary: string;
  expected_outputs: string[];
}

export interface FullContext {
  task_description: string;
  codebase_files: FileContext[];
  requirements: Requirement[];
  constraints: string[];
  shared_knowledge: SharedKnowledge[];
  metadata: Record<string, any>;
}

export interface FileContext {
  file_path: string;
  content_summary: string;
  key_functions: string[];
  dependencies: string[];
  last_modified: number;
}

export interface Requirement {
  requirement_id: string;
  description: string;
  priority: 'must_have' | 'should_have' | 'could_have';
  status: 'pending' | 'in_progress' | 'completed';
  assigned_to?: string[];
}

export interface SharedKnowledge {
  knowledge_id: string;
  type: 'architecture_pattern' | 'coding_standard' | 'business_rule' | 'technical_constraint';
  content: string;
  relevance_score: number;
}

export interface ContextDelta {
  added_discoveries: Discovery[];
  updated_work_units: WorkUnit[];
  new_outputs: Record<string, any>;
  version: number;
  timestamp: number;
}

export interface CompressionResult {
  summary: string;
  reference_key: string;
  expansion_hints: string[];
  compression_ratio: number;
  original_token_count: number;
  compressed_token_count: number;
}

export interface DependencyWaitRequest {
  session_id: string;
  dependency_key: string;
  requesting_worker: string;
  timeout_ms: number;
  created_at: number;
}

export interface OutputPublication {
  session_id: string;
  output_key: string;
  data: any;
  producer_worker: string;
  timestamp: number;
  version: number;
}