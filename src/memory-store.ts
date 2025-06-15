import { 
  AgenticSession, 
  ContextRef, 
  WorkUnit, 
  Discovery, 
  FullContext, 
  ContextDelta,
  CompressionResult,
  DependencyWaitRequest,
  OutputPublication
} from './types';

export class SharedMemoryStore {
  private sessions = new Map<string, AgenticSession>();
  private contexts = new Map<string, FullContext>();
  private contextRefs = new Map<string, ContextRef>();
  private discoveries = new Map<string, Discovery[]>();
  private outputs = new Map<string, Record<string, OutputPublication>>();
  private dependencyWaiters = new Map<string, DependencyWaitRequest[]>();
  
  private readonly DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_SUMMARY_TOKENS = 100;
  private readonly COMPRESSION_RATIO_TARGET = 0.1; // 10:1 compression

  constructor() {
    this.startCleanupTimer();
  }

  // Session Management
  createSession(
    coordinatorId: string, 
    workerIds: string[], 
    fullContext: FullContext,
    ttl?: number
  ): string {
    const sessionId = this.generateId('session');
    const contextRef = this.storeContext(fullContext);
    
    const session: AgenticSession = {
      session_id: sessionId,
      coordinator_id: coordinatorId,
      worker_ids: workerIds,
      shared_context: contextRef,
      work_units: [],
      discoveries: [],
      outputs: {},
      status: 'planning',
      created_at: Date.now(),
      updated_at: Date.now(),
      ttl: ttl || this.DEFAULT_TTL
    };

    this.sessions.set(sessionId, session);
    this.discoveries.set(sessionId, []);
    this.outputs.set(sessionId, {});
    this.dependencyWaiters.set(sessionId, []);

    return sessionId;
  }

  getSession(sessionId: string): AgenticSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // Check TTL
    if (this.isExpired(session)) {
      this.cleanupSession(sessionId);
      return null;
    }
    
    return session;
  }

  updateSessionStatus(sessionId: string, status: AgenticSession['status']): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    session.status = status;
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }

  // Context Management with Compression
  private storeContext(fullContext: FullContext): ContextRef {
    const contextKey = this.generateId('context');
    const compressed = this.compressContext(fullContext);
    
    this.contexts.set(contextKey, fullContext);
    
    const contextRef: ContextRef = {
      ref_id: this.generateId('ref'),
      summary: compressed.summary,
      full_context_key: contextKey,
      version: 1,
      token_count: compressed.compressed_token_count,
      created_at: Date.now()
    };
    
    this.contextRefs.set(contextRef.ref_id, contextRef);
    return contextRef;
  }

  getFullContext(refId: string): FullContext | null {
    const contextRef = this.contextRefs.get(refId);
    if (!contextRef) return null;
    
    return this.contexts.get(contextRef.full_context_key) || null;
  }

  expandContextSection(refId: string, section: string): any {
    const fullContext = this.getFullContext(refId);
    if (!fullContext) return null;
    
    switch (section) {
      case 'codebase_files':
        return fullContext.codebase_files;
      case 'requirements':
        return fullContext.requirements;
      case 'constraints':
        return fullContext.constraints;
      case 'shared_knowledge':
        return fullContext.shared_knowledge;
      default:
        return (fullContext as any)[section] || null;
    }
  }

  private compressContext(fullContext: FullContext): CompressionResult {
    const originalTokens = this.estimateTokens(JSON.stringify(fullContext));
    
    const summary = [
      `Task: ${fullContext.task_description.substring(0, 200)}...`,
      `Files: ${fullContext.codebase_files.length} files including ${fullContext.codebase_files.slice(0, 3).map(f => f.file_path).join(', ')}`,
      `Requirements: ${fullContext.requirements.length} requirements (${fullContext.requirements.filter(r => r.priority === 'must_have').length} critical)`,
      `Constraints: ${fullContext.constraints.length} constraints`
    ].join('\n');
    
    const compressedTokens = this.estimateTokens(summary);
    
    return {
      summary,
      reference_key: this.generateId('compress'),
      expansion_hints: ['codebase_files', 'requirements', 'constraints', 'shared_knowledge'],
      compression_ratio: compressedTokens / originalTokens,
      original_token_count: originalTokens,
      compressed_token_count: compressedTokens
    };
  }

  // Work Unit Management
  publishWorkUnits(sessionId: string, units: WorkUnit[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    session.work_units.push(...units);
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }

  claimWorkUnit(sessionId: string, unitId: string, workerId: string, estimatedDuration: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    const unit = session.work_units.find(u => u.unit_id === unitId);
    if (!unit || unit.status !== 'available') return false;
    
    unit.status = 'claimed';
    unit.claimed_by = workerId;
    unit.estimated_duration = estimatedDuration;
    unit.updated_at = Date.now();
    
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }

  updateWorkStatus(sessionId: string, unitId: string, status: WorkUnit['status'], result?: any): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    const unit = session.work_units.find(u => u.unit_id === unitId);
    if (!unit) return false;
    
    unit.status = status;
    unit.updated_at = Date.now();
    if (result !== undefined) {
      unit.result = result;
    }
    if (status === 'completed' && unit.estimated_duration) {
      unit.actual_duration = Date.now() - (unit.updated_at - (unit.estimated_duration * 1000));
    }
    
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }

  // Discovery Management
  appendDiscovery(sessionId: string, workerId: string, discovery: Omit<Discovery, 'discovery_id' | 'session_id' | 'worker_id' | 'timestamp' | 'version'>): string {
    const sessionDiscoveries = this.discoveries.get(sessionId) || [];
    
    const discoveryRecord: Discovery = {
      discovery_id: this.generateId('discovery'),
      session_id: sessionId,
      worker_id: workerId,
      timestamp: Date.now(),
      version: sessionDiscoveries.length + 1,
      ...discovery
    };
    
    sessionDiscoveries.push(discoveryRecord);
    this.discoveries.set(sessionId, sessionDiscoveries);
    
    // Update session timestamp
    const session = this.sessions.get(sessionId);
    if (session) {
      session.updated_at = Date.now();
      this.sessions.set(sessionId, session);
    }
    
    return discoveryRecord.discovery_id;
  }

  getDiscoveriesSince(sessionId: string, sinceTimestamp: number): Discovery[] {
    const sessionDiscoveries = this.discoveries.get(sessionId) || [];
    return sessionDiscoveries.filter(d => d.timestamp > sinceTimestamp);
  }

  getContextDelta(sessionId: string, workerId: string, sinceVersion: number): ContextDelta | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    const discoveries = this.discoveries.get(sessionId) || [];
    const outputs = this.outputs.get(sessionId) || {};
    
    return {
      added_discoveries: discoveries.filter(d => d.version > sinceVersion),
      updated_work_units: session.work_units.filter(u => u.updated_at > sinceVersion),
      new_outputs: Object.fromEntries(
        Object.entries(outputs).filter(([_, pub]) => pub.timestamp > sinceVersion)
      ),
      version: Math.max(discoveries.length, session.work_units.length),
      timestamp: Date.now()
    };
  }

  // Dependency Resolution
  declareOutputs(sessionId: string, workerId: string, outputKeys: string[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.worker_ids.includes(workerId)) return false;
    
    // Store the worker's output declarations
    const outputs = this.outputs.get(sessionId) || {};
    for (const key of outputKeys) {
      if (!outputs[key]) {
        outputs[key] = {
          session_id: sessionId,
          output_key: key,
          data: null, // Will be filled when actually published
          producer_worker: workerId,
          timestamp: 0, // Will be set when published
          version: 0
        };
      }
    }
    this.outputs.set(sessionId, outputs);
    return true;
  }

  async awaitDependency(sessionId: string, dependencyKey: string, timeoutMs: number): Promise<any> {
    const outputs = this.outputs.get(sessionId) || {};
    const output = outputs[dependencyKey];
    
    // If already available, return immediately
    if (output && output.data !== null) {
      return output.data;
    }
    
    // Add to waiters
    const waiters = this.dependencyWaiters.get(sessionId) || [];
    const waitRequest: DependencyWaitRequest = {
      session_id: sessionId,
      dependency_key: dependencyKey,
      requesting_worker: 'unknown', // Could be enhanced to track
      timeout_ms: timeoutMs,
      created_at: Date.now()
    };
    waiters.push(waitRequest);
    this.dependencyWaiters.set(sessionId, waiters);
    
    // Return a promise that resolves when the dependency is available
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const currentOutputs = this.outputs.get(sessionId) || {};
        const currentOutput = currentOutputs[dependencyKey];
        
        if (currentOutput && currentOutput.data !== null) {
          clearInterval(checkInterval);
          resolve(currentOutput.data);
        } else if (Date.now() - waitRequest.created_at > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for dependency: ${dependencyKey}`));
        }
      }, 100); // Check every 100ms
    });
  }

  publishOutput(sessionId: string, outputKey: string, data: any): boolean {
    const outputs = this.outputs.get(sessionId) || {};
    const existing = outputs[outputKey];
    
    if (!existing) return false;
    
    outputs[outputKey] = {
      ...existing,
      data,
      timestamp: Date.now(),
      version: existing.version + 1
    };
    
    this.outputs.set(sessionId, outputs);
    return true;
  }

  // Utility Methods
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private estimateTokens(text: string): number {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  private isExpired(session: AgenticSession): boolean {
    if (!session.ttl) return false;
    return Date.now() - session.created_at > session.ttl;
  }

  private cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.discoveries.delete(sessionId);
    this.outputs.delete(sessionId);
    this.dependencyWaiters.delete(sessionId);
    
    // Clean up context references if no other sessions use them
    // This is simplified - a production version would need reference counting
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      const expiredSessions: string[] = [];
      
      for (const [sessionId, session] of this.sessions.entries()) {
        if (this.isExpired(session)) {
          expiredSessions.push(sessionId);
        }
      }
      
      expiredSessions.forEach(sessionId => this.cleanupSession(sessionId));
    }, 60 * 1000); // Clean up every minute
  }

  // Debug/Monitoring Methods
  getSessionStats(): { active: number; total_contexts: number; total_discoveries: number } {
    let totalDiscoveries = 0;
    for (const discoveries of this.discoveries.values()) {
      totalDiscoveries += discoveries.length;
    }
    
    return {
      active: this.sessions.size,
      total_contexts: this.contexts.size,
      total_discoveries: totalDiscoveries
    };
  }
}