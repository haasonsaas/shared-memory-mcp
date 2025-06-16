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
import { SharedMemoryConfig, defaultConfig } from './config';

export class SharedMemoryStore {
  private sessions = new Map<string, AgenticSession>();
  private contexts = new Map<string, FullContext>();
  private contextRefs = new Map<string, ContextRef>();
  private contextRefCount = new Map<string, Set<string>>(); // contextKey -> Set of sessionIds
  private discoveries = new Map<string, Discovery[]>();
  private outputs = new Map<string, Record<string, OutputPublication>>();
  private dependencyWaiters = new Map<string, DependencyWaitRequest[]>();
  private dependencyResolvers = new Map<string, Array<(data: any) => void>>(); // key -> resolvers
  // Performance optimization: Map work units by session_id -> unit_id for O(1) lookup
  private workUnitIndex = new Map<string, Map<string, WorkUnit>>();
  
  readonly config: Required<SharedMemoryConfig>;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config?: SharedMemoryConfig) {
    this.config = { ...defaultConfig, ...config };
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
    const contextRef = this.storeContext(fullContext, sessionId);
    
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
      ttl: ttl || this.config.defaultTTL
    };

    this.sessions.set(sessionId, session);
    this.discoveries.set(sessionId, []);
    this.outputs.set(sessionId, {});
    this.dependencyWaiters.set(sessionId, []);
    this.workUnitIndex.set(sessionId, new Map());

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
  private storeContext(fullContext: FullContext, sessionId: string): ContextRef {
    try {
      const contextKey = this.generateId('context');
      const compressed = this.compressContext(fullContext);
      
      this.contexts.set(contextKey, fullContext);
      
      // Track reference count for this context
      if (!this.contextRefCount.has(contextKey)) {
        this.contextRefCount.set(contextKey, new Set());
      }
      this.contextRefCount.get(contextKey)!.add(sessionId);
      
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
    } catch (error) {
      console.error('Error storing context:', error);
      throw new Error('Failed to store context: ' + (error as Error).message);
    }
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
      `Task: ${fullContext.task_description.substring(0, this.config.maxTaskDescriptionLength)}...`,
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
    
    const sessionUnits = this.workUnitIndex.get(sessionId);
    if (!sessionUnits) return false;
    
    // Check for circular dependencies before adding
    const allUnits = [...session.work_units, ...units];
    if (this.hasCircularDependencies(allUnits)) {
      throw new Error('Circular dependencies detected in work units');
    }
    
    // Add to both array and index
    for (const unit of units) {
      session.work_units.push(unit);
      sessionUnits.set(unit.unit_id, unit);
    }
    
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }
  
  private hasCircularDependencies(units: WorkUnit[]): boolean {
    try {
      // Build dependency graph
      const graph = new Map<string, string[]>();
      units.forEach(unit => {
        graph.set(unit.unit_id, unit.dependencies || []);
      });
      
      // Check for cycles using DFS
      const visited = new Set<string>();
      const recursionStack = new Set<string>();
      
      const hasCycle = (unitId: string): boolean => {
        visited.add(unitId);
        recursionStack.add(unitId);
        
        const dependencies = graph.get(unitId) || [];
        for (const dep of dependencies) {
          if (!visited.has(dep)) {
            if (hasCycle(dep)) return true;
          } else if (recursionStack.has(dep)) {
            return true; // Found a cycle
          }
        }
        
        recursionStack.delete(unitId);
        return false;
      };
      
      // Check each unit
      for (const unit of units) {
        if (!visited.has(unit.unit_id)) {
          if (hasCycle(unit.unit_id)) return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error checking circular dependencies:', error);
      // On error, assume there might be circular dependencies to be safe
      return true;
    }
  }

  claimWorkUnit(sessionId: string, unitId: string, workerId: string, estimatedDuration: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    const sessionUnits = this.workUnitIndex.get(sessionId);
    if (!sessionUnits) return false;
    
    const unit = sessionUnits.get(unitId);
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
    
    const sessionUnits = this.workUnitIndex.get(sessionId);
    if (!sessionUnits) return false;
    
    const unit = sessionUnits.get(unitId);
    if (!unit) return false;
    
    unit.status = status;
    unit.updated_at = Date.now();
    
    // Track when work actually starts
    if (status === 'in_progress' && !unit.started_at) {
      unit.started_at = Date.now();
    }
    
    if (result !== undefined) {
      unit.result = result;
    }
    
    // Calculate actual duration when completed
    if (status === 'completed' && unit.started_at) {
      unit.actual_duration = Math.round((Date.now() - unit.started_at) / 1000); // in seconds
    }
    
    session.updated_at = Date.now();
    this.sessions.set(sessionId, session);
    return true;
  }

  // Discovery Management
  appendDiscovery(sessionId: string, workerId: string, discovery: Omit<Discovery, 'discovery_id' | 'session_id' | 'worker_id' | 'timestamp' | 'version'>): string {
    const sessionDiscoveries = this.discoveries.get(sessionId) || [];
    
    // Check if we're at the limit and need to remove old discoveries
    if (sessionDiscoveries.length >= this.config.maxDiscoveriesPerSession) {
      // Remove oldest 10% of discoveries to make room
      const removeCount = Math.max(1, Math.floor(this.config.maxDiscoveriesPerSession * 0.1));
      sessionDiscoveries.splice(0, removeCount);
    }
    
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
    try {
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
        requesting_worker: 'unknown',
        timeout_ms: timeoutMs,
        created_at: Date.now()
      };
      waiters.push(waitRequest);
      this.dependencyWaiters.set(sessionId, waiters);
      
      // Create resolver key
      const resolverKey = `${sessionId}:${dependencyKey}`;
      
      // Return a promise that resolves when the dependency is available
      return new Promise((resolve, reject) => {
      // Add resolver to the map
      const resolvers = this.dependencyResolvers.get(resolverKey) || [];
      resolvers.push(resolve);
      this.dependencyResolvers.set(resolverKey, resolvers);
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        // Remove this resolver
        const currentResolvers = this.dependencyResolvers.get(resolverKey) || [];
        const index = currentResolvers.indexOf(resolve);
        if (index >= 0) {
          currentResolvers.splice(index, 1);
          if (currentResolvers.length === 0) {
            this.dependencyResolvers.delete(resolverKey);
          } else {
            this.dependencyResolvers.set(resolverKey, currentResolvers);
          }
        }
        
        // Clean up wait request
        const waitRequests = this.dependencyWaiters.get(sessionId) || [];
        const updatedRequests = waitRequests.filter(req => req.dependency_key !== dependencyKey);
        if (updatedRequests.length === 0) {
          this.dependencyWaiters.delete(sessionId);
        } else {
          this.dependencyWaiters.set(sessionId, updatedRequests);
        }
        
        reject(new Error(`Timeout waiting for dependency: ${dependencyKey}`));
      }, timeoutMs);
      
      // Store timeout for cleanup
      (resolve as any).__timeoutId = timeoutId;
    });
    } catch (error) {
      console.error('Error in awaitDependency:', error);
      throw error;
    }
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
    
    // Notify all waiters
    const resolverKey = `${sessionId}:${outputKey}`;
    const resolvers = this.dependencyResolvers.get(resolverKey);
    
    if (resolvers && resolvers.length > 0) {
      // Clear all timeouts and resolve promises
      resolvers.forEach(resolve => {
        const timeoutId = (resolve as any).__timeoutId;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(data);
      });
      
      // Clean up resolvers
      this.dependencyResolvers.delete(resolverKey);
    }
    
    return true;
  }

  // Utility Methods
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private validateWorkerAccess(sessionId: string, workerId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    // Check if worker is coordinator or one of the assigned workers
    return session.coordinator_id === workerId || session.worker_ids.includes(workerId);
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
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    // Clean up session data
    this.sessions.delete(sessionId);
    this.discoveries.delete(sessionId);
    this.outputs.delete(sessionId);
    this.dependencyWaiters.delete(sessionId);
    this.workUnitIndex.delete(sessionId);
    
    // Clean up any pending dependency resolvers
    this.dependencyResolvers.forEach((resolvers, key) => {
      if (key.startsWith(`${sessionId}:`)) {
        // Clear timeouts for all resolvers
        resolvers.forEach(resolve => {
          const timeoutId = (resolve as any).__timeoutId;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        });
        this.dependencyResolvers.delete(key);
      }
    });
    
    // Clean up context references with proper reference counting
    const contextKey = session.shared_context.full_context_key;
    const sessionRefs = this.contextRefCount.get(contextKey);
    
    if (sessionRefs) {
      sessionRefs.delete(sessionId);
      
      // If no more sessions reference this context, clean it up
      if (sessionRefs.size === 0) {
        this.contexts.delete(contextKey);
        this.contextRefCount.delete(contextKey);
        
        // Clean up the context ref as well
        this.contextRefs.delete(session.shared_context.ref_id);
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      try {
        const now = Date.now();
        const expiredSessions: string[] = [];
        
        for (const [sessionId, session] of this.sessions.entries()) {
          if (this.isExpired(session)) {
            expiredSessions.push(sessionId);
          }
        }
        
        expiredSessions.forEach(sessionId => this.cleanupSession(sessionId));
      } catch (error) {
        console.error('Error during cleanup timer:', error);
      }
    }, this.config.cleanupIntervalMs);
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

  // Cleanup method to stop timers
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    
    // Clean up all pending dependency resolvers
    for (const [resolverKey, resolvers] of this.dependencyResolvers.entries()) {
      resolvers.forEach(resolve => {
        const timeoutId = (resolve as any).__timeoutId;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });
    }
    this.dependencyResolvers.clear();
  }
}