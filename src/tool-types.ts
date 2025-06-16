// Tool argument interfaces for type safety

export interface CreateSessionArgs {
  coordinator_id: string;
  worker_ids: string[];
  task_description: string;
  requirements?: Array<{
    requirement_id: string;
    description: string;
    priority: 'must_have' | 'should_have' | 'could_have';
    status?: 'pending' | 'in_progress' | 'completed';
  }>;
  codebase_files?: Array<{
    file_path: string;
    content_summary: string;
    key_functions?: string[];
    dependencies?: string[];
  }>;
  constraints?: string[];
  ttl_minutes?: number;
}

export interface GetSessionInfoArgs {
  session_id: string;
}

export interface UpdateSessionStatusArgs {
  session_id: string;
  status: 'planning' | 'executing' | 'consolidating' | 'complete';
}

export interface GetWorkerContextArgs {
  session_id: string;
  worker_id: string;
  since_version?: number;
}

export interface ExpandContextSectionArgs {
  session_id: string;
  section: string;
}

export interface GetContextDeltaArgs {
  session_id: string;
  worker_id: string;
  since_version: number;
}

export interface PublishWorkUnitsArgs {
  session_id: string;
  work_units: Array<{
    unit_id: string;
    type: string;
    description: string;
    priority: 'low' | 'medium' | 'high';
    dependencies?: string[];
  }>;
}

export interface ClaimWorkUnitArgs {
  session_id: string;
  unit_id: string;
  worker_id: string;
  estimated_duration_minutes: number;
}

export interface UpdateWorkStatusArgs {
  session_id: string;
  unit_id: string;
  status: 'in_progress' | 'completed' | 'blocked';
  result?: any;
}

export interface AddDiscoveryArgs {
  session_id: string;
  worker_id: string;
  discovery_type: 'function_found' | 'dependency_identified' | 'error_pattern' | 'optimization_opportunity' | 'requirement_clarification';
  data: any;
  affects_workers?: string[];
}

export interface GetDiscoveriesSinceArgs {
  session_id: string;
  since_timestamp: number;
}

export interface DeclareOutputsArgs {
  session_id: string;
  worker_id: string;
  output_keys: string[];
}

export interface AwaitDependencyArgs {
  session_id: string;
  dependency_key: string;
  timeout_minutes?: number;
}

export interface PublishOutputArgs {
  session_id: string;
  output_key: string;
  data: any;
}