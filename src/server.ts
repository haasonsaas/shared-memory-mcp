#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { SharedMemoryStore } from './memory-store';
import { 
  AgenticSession, 
  WorkUnit, 
  Discovery, 
  FullContext,
  WorkerContext,
  ContextDelta
} from './types';
import * as ToolArgs from './tool-types';
import { SharedMemoryConfig, defaultConfig } from './config';
import * as Validation from './validation';

class SharedMemoryMCPServer {
  private server: Server;
  private memoryStore: SharedMemoryStore;

  constructor(config?: SharedMemoryConfig) {
    this.memoryStore = new SharedMemoryStore(config);
    this.server = new Server(
      {
        name: 'shared-memory-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private validateWorkerInSession(session: AgenticSession, workerId: string): void {
    if (!session.worker_ids.includes(workerId) && workerId !== session.coordinator_id) {
      throw new Validation.ValidationError(`Worker ${workerId} is not part of session ${session.session_id}`);
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Session Management
          {
            name: 'create_agentic_session',
            description: 'Create a new agentic session with shared context for coordinator and workers',
            inputSchema: {
              type: 'object',
              properties: {
                coordinator_id: { type: 'string', description: 'ID of the coordinator agent' },
                worker_ids: { type: 'array', items: { type: 'string' }, description: 'Array of worker agent IDs' },
                task_description: { type: 'string', description: 'Main task description' },
                codebase_files: { 
                  type: 'array', 
                  items: {
                    type: 'object',
                    properties: {
                      file_path: { type: 'string' },
                      content_summary: { type: 'string' },
                      key_functions: { type: 'array', items: { type: 'string' } },
                      dependencies: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['file_path', 'content_summary']
                  }
                },
                requirements: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      requirement_id: { type: 'string' },
                      description: { type: 'string' },
                      priority: { type: 'string', enum: ['must_have', 'should_have', 'could_have'] },
                      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                    },
                    required: ['requirement_id', 'description', 'priority']
                  }
                },
                constraints: { type: 'array', items: { type: 'string' } },
                ttl_minutes: { type: 'number', description: 'Session TTL in minutes (default: 1440 = 24h)' }
              },
              required: ['coordinator_id', 'worker_ids', 'task_description']
            }
          },
          {
            name: 'get_session_info',
            description: 'Get information about an agentic session',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' }
              },
              required: ['session_id']
            }
          },
          {
            name: 'update_session_status',
            description: 'Update the status of an agentic session',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                status: { type: 'string', enum: ['planning', 'executing', 'consolidating', 'complete'] }
              },
              required: ['session_id', 'status']
            }
          },

          // Context Management
          {
            name: 'get_worker_context',
            description: 'Get compressed context for a specific worker',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                worker_id: { type: 'string', description: 'Worker ID' },
                since_version: { type: 'number', description: 'Get updates since this version (optional)' }
              },
              required: ['session_id', 'worker_id']
            }
          },
          {
            name: 'expand_context_section',
            description: 'Get detailed information for a specific context section',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                section: { type: 'string', description: 'Context section to expand (e.g., "codebase_files", "requirements")' }
              },
              required: ['session_id', 'section']
            }
          },
          {
            name: 'get_context_delta',
            description: 'Get incremental updates since a specific version',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                worker_id: { type: 'string', description: 'Worker ID' },
                since_version: { type: 'number', description: 'Version number to get updates since' }
              },
              required: ['session_id', 'worker_id', 'since_version']
            }
          },

          // Work Coordination
          {
            name: 'publish_work_units',
            description: 'Publish available work units for workers to claim',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                work_units: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      unit_id: { type: 'string' },
                      type: { type: 'string' },
                      description: { type: 'string' },
                      dependencies: { type: 'array', items: { type: 'string' } },
                      priority: { type: 'string', enum: ['low', 'medium', 'high'] }
                    },
                    required: ['unit_id', 'type', 'description', 'priority']
                  }
                }
              },
              required: ['session_id', 'work_units']
            }
          },
          {
            name: 'claim_work_unit',
            description: 'Claim a specific work unit for execution',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                unit_id: { type: 'string', description: 'Work unit ID to claim' },
                worker_id: { type: 'string', description: 'Worker claiming the unit' },
                estimated_duration_minutes: { type: 'number', description: 'Estimated duration in minutes' }
              },
              required: ['session_id', 'unit_id', 'worker_id', 'estimated_duration_minutes']
            }
          },
          {
            name: 'update_work_status',
            description: 'Update the status of a work unit',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                unit_id: { type: 'string', description: 'Work unit ID' },
                status: { type: 'string', enum: ['in_progress', 'completed', 'blocked'] },
                result: { type: 'object', description: 'Result data (for completed units)' }
              },
              required: ['session_id', 'unit_id', 'status']
            }
          },

          // Discovery and State Sharing
          {
            name: 'add_discovery',
            description: 'Add a discovery that other workers can benefit from',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                worker_id: { type: 'string', description: 'Worker making the discovery' },
                discovery_type: { 
                  type: 'string', 
                  enum: ['function_found', 'dependency_identified', 'error_pattern', 'optimization_opportunity', 'requirement_clarification'],
                  description: 'Type of discovery'
                },
                data: { type: 'object', description: 'Discovery data' },
                affects_workers: { type: 'array', items: { type: 'string' }, description: 'Worker IDs that should be notified (optional)' }
              },
              required: ['session_id', 'worker_id', 'discovery_type', 'data']
            }
          },
          {
            name: 'get_discoveries_since',
            description: 'Get discoveries made since a specific timestamp',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                since_timestamp: { type: 'number', description: 'Timestamp (milliseconds since epoch)' }
              },
              required: ['session_id', 'since_timestamp']
            }
          },

          // Dependency Resolution
          {
            name: 'declare_outputs',
            description: 'Declare what outputs this worker will produce',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                worker_id: { type: 'string', description: 'Worker ID' },
                output_keys: { type: 'array', items: { type: 'string' }, description: 'Keys of outputs this worker will produce' }
              },
              required: ['session_id', 'worker_id', 'output_keys']
            }
          },
          {
            name: 'await_dependency',
            description: 'Wait for a dependency to become available',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                dependency_key: { type: 'string', description: 'Key of the dependency to wait for' },
                timeout_minutes: { type: 'number', description: 'Timeout in minutes (default: 30)' }
              },
              required: ['session_id', 'dependency_key']
            }
          },
          {
            name: 'publish_output',
            description: 'Publish an output for other workers to consume',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                output_key: { type: 'string', description: 'Key of the output' },
                data: { type: 'object', description: 'Output data' }
              },
              required: ['session_id', 'output_key', 'data']
            }
          },

          // Monitoring and Debug
          {
            name: 'get_session_stats',
            description: 'Get statistics about the shared memory system',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          }
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      try {
        // Type-safe argument passing using proper type assertion
        switch (name) {
          case 'create_agentic_session':
            return await this.createAgenticSession(args as unknown as ToolArgs.CreateSessionArgs);
          case 'get_session_info':
            return await this.getSessionInfo(args as unknown as ToolArgs.GetSessionInfoArgs);
          case 'update_session_status':
            return await this.updateSessionStatus(args as unknown as ToolArgs.UpdateSessionStatusArgs);
          case 'get_worker_context':
            return await this.getWorkerContext(args as unknown as ToolArgs.GetWorkerContextArgs);
          case 'expand_context_section':
            return await this.expandContextSection(args as unknown as ToolArgs.ExpandContextSectionArgs);
          case 'get_context_delta':
            return await this.getContextDelta(args as unknown as ToolArgs.GetContextDeltaArgs);
          case 'publish_work_units':
            return await this.publishWorkUnits(args as unknown as ToolArgs.PublishWorkUnitsArgs);
          case 'claim_work_unit':
            return await this.claimWorkUnit(args as unknown as ToolArgs.ClaimWorkUnitArgs);
          case 'update_work_status':
            return await this.updateWorkStatus(args as unknown as ToolArgs.UpdateWorkStatusArgs);
          case 'add_discovery':
            return await this.addDiscovery(args as unknown as ToolArgs.AddDiscoveryArgs);
          case 'get_discoveries_since':
            return await this.getDiscoveriesSince(args as unknown as ToolArgs.GetDiscoveriesSinceArgs);
          case 'declare_outputs':
            return await this.declareOutputs(args as unknown as ToolArgs.DeclareOutputsArgs);
          case 'await_dependency':
            return await this.awaitDependency(args as unknown as ToolArgs.AwaitDependencyArgs);
          case 'publish_output':
            return await this.publishOutput(args as unknown as ToolArgs.PublishOutputArgs);
          case 'get_session_stats':
            return await this.getSessionStats((args || {}) as {});
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error}`);
      }
    });
  }

  // Tool implementations
  private async createAgenticSession(args: ToolArgs.CreateSessionArgs) {
    const { 
      coordinator_id, 
      worker_ids, 
      task_description, 
      codebase_files = [], 
      requirements = [], 
      constraints = [],
      ttl_minutes = 1440
    } = args;

    // Validation
    Validation.validateWorkerId(coordinator_id);
    Validation.validateWorkerIds(worker_ids, this.memoryStore.config);
    
    if (!task_description || typeof task_description !== 'string' || task_description.trim() === '') {
      throw new Validation.ValidationError('Task description is required and must be a non-empty string');
    }
    
    if (ttl_minutes !== undefined) {
      Validation.validatePositiveNumber(ttl_minutes, 'TTL minutes');
    }

    const fullContext: FullContext = {
      task_description,
      codebase_files: codebase_files.map(f => ({
        file_path: f.file_path,
        content_summary: f.content_summary,
        key_functions: f.key_functions || [],
        dependencies: f.dependencies || [],
        last_modified: Date.now()
      })),
      requirements: requirements.map(r => ({
        requirement_id: r.requirement_id,
        description: r.description,
        priority: r.priority,
        status: r.status || 'pending'
      })),
      constraints,
      shared_knowledge: [],
      metadata: {
        created_by: coordinator_id,
        created_at: Date.now()
      }
    };

    const sessionId = this.memoryStore.createSession(
      coordinator_id,
      worker_ids,
      fullContext,
      ttl_minutes * 60 * 1000
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_id: sessionId,
          coordinator_id,
          worker_ids,
          status: 'planning',
          context_summary: fullContext.task_description.substring(0, 200) + '...',
          created_at: new Date().toISOString()
        }, null, 2)
      }]
    };
  }

  private async getSessionInfo(args: ToolArgs.GetSessionInfoArgs) {
    const { session_id } = args;
    const session = this.memoryStore.getSession(session_id);
    
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(session, null, 2)
      }]
    };
  }

  private async updateSessionStatus(args: ToolArgs.UpdateSessionStatusArgs) {
    const { session_id, status } = args;
    
    // Validation
    Validation.validateSessionId(session_id);
    Validation.validateSessionStatus(status);
    
    const success = this.memoryStore.updateSessionStatus(session_id, status);
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to update session status: ${session_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ session_id, status, updated_at: new Date().toISOString() })
      }]
    };
  }

  private async getWorkerContext(args: ToolArgs.GetWorkerContextArgs) {
    const { session_id, worker_id, since_version } = args;
    
    // Validation
    Validation.validateSessionId(session_id);
    Validation.validateWorkerId(worker_id);
    
    const session = this.memoryStore.getSession(session_id);
    
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }

    this.validateWorkerInSession(session, worker_id);

    const context: WorkerContext = {
      shared_context_ref: session.shared_context.ref_id,
      worker_specific: {
        worker_id,
        assigned_units: session.work_units
          .filter(u => u.claimed_by === worker_id)
          .map(u => u.unit_id),
        context_summary: session.shared_context.summary,
        expected_outputs: [] // Could be enhanced
      },
      dependencies: session.work_units
        .filter(u => u.claimed_by === worker_id)
        .flatMap(u => u.dependencies),
      discoveries_since: since_version || 0
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(context, null, 2)
      }]
    };
  }

  private async expandContextSection(args: ToolArgs.ExpandContextSectionArgs) {
    const { session_id, section } = args;
    const session = this.memoryStore.getSession(session_id);
    
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }

    const sectionData = this.memoryStore.expandContextSection(session.shared_context.ref_id, section);
    
    if (!sectionData) {
      throw new McpError(ErrorCode.InvalidParams, `Context section not found: ${section}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(sectionData, null, 2)
      }]
    };
  }

  private async getContextDelta(args: ToolArgs.GetContextDeltaArgs) {
    const { session_id, worker_id, since_version } = args;
    const delta = this.memoryStore.getContextDelta(session_id, worker_id, since_version);
    
    if (!delta) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(delta, null, 2)
      }]
    };
  }

  private async publishWorkUnits(args: ToolArgs.PublishWorkUnitsArgs) {
    const { session_id, work_units } = args;
    
    // Validation
    Validation.validateSessionId(session_id);
    Validation.validateWorkUnits(work_units, this.memoryStore.config);
    
    const units: WorkUnit[] = work_units.map(u => ({
      unit_id: u.unit_id,
      type: u.type,
      description: u.description,
      status: 'available' as const,
      dependencies: u.dependencies || [],
      priority: u.priority,
      created_at: Date.now(),
      updated_at: Date.now()
    }));

    const success = this.memoryStore.publishWorkUnits(session_id, units);
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to publish work units for session: ${session_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          published_units: units.length,
          unit_ids: units.map(u => u.unit_id)
        })
      }]
    };
  }

  private async claimWorkUnit(args: ToolArgs.ClaimWorkUnitArgs) {
    const { session_id, unit_id, worker_id, estimated_duration_minutes } = args;
    
    // Validate worker belongs to session
    const session = this.memoryStore.getSession(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }
    this.validateWorkerInSession(session, worker_id);
    
    const success = this.memoryStore.claimWorkUnit(
      session_id, 
      unit_id, 
      worker_id, 
      estimated_duration_minutes * 60 * 1000
    );
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to claim work unit: ${unit_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          unit_id, 
          worker_id, 
          status: 'claimed',
          estimated_duration_minutes 
        })
      }]
    };
  }

  private async updateWorkStatus(args: ToolArgs.UpdateWorkStatusArgs) {
    const { session_id, unit_id, status, result } = args;
    
    const success = this.memoryStore.updateWorkStatus(session_id, unit_id, status, result);
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to update work unit status: ${unit_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          unit_id, 
          status, 
          updated_at: new Date().toISOString()
        })
      }]
    };
  }

  private async addDiscovery(args: ToolArgs.AddDiscoveryArgs) {
    const { session_id, worker_id, discovery_type, data, affects_workers } = args;
    
    // Validate worker belongs to session
    const session = this.memoryStore.getSession(session_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Session not found: ${session_id}`);
    }
    this.validateWorkerInSession(session, worker_id);
    
    const discoveryId = this.memoryStore.appendDiscovery(session_id, worker_id, {
      type: discovery_type,
      data,
      affects_workers
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          discovery_id: discoveryId,
          session_id, 
          worker_id, 
          type: discovery_type,
          timestamp: new Date().toISOString()
        })
      }]
    };
  }

  private async getDiscoveriesSince(args: ToolArgs.GetDiscoveriesSinceArgs) {
    const { session_id, since_timestamp } = args;
    
    const discoveries = this.memoryStore.getDiscoveriesSince(session_id, since_timestamp);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          discoveries,
          count: discoveries.length
        }, null, 2)
      }]
    };
  }

  private async declareOutputs(args: ToolArgs.DeclareOutputsArgs) {
    const { session_id, worker_id, output_keys } = args;
    
    const success = this.memoryStore.declareOutputs(session_id, worker_id, output_keys);
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to declare outputs for worker: ${worker_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          worker_id, 
          declared_outputs: output_keys
        })
      }]
    };
  }

  private async awaitDependency(args: ToolArgs.AwaitDependencyArgs) {
    const { session_id, dependency_key, timeout_minutes = 30 } = args;
    
    try {
      const data = await this.memoryStore.awaitDependency(
        session_id, 
        dependency_key, 
        timeout_minutes * 60 * 1000
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ 
            session_id, 
            dependency_key, 
            data,
            resolved_at: new Date().toISOString()
          })
        }]
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Dependency timeout: ${dependency_key}`);
    }
  }

  private async publishOutput(args: ToolArgs.PublishOutputArgs) {
    const { session_id, output_key, data } = args;
    
    const success = this.memoryStore.publishOutput(session_id, output_key, data);
    
    if (!success) {
      throw new McpError(ErrorCode.InvalidParams, `Failed to publish output: ${output_key}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ 
          session_id, 
          output_key, 
          published_at: new Date().toISOString()
        })
      }]
    };
  }

  private async getSessionStats(_args: {}) {
    const stats = this.memoryStore.getSessionStats();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(stats, null, 2)
      }]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Shared Memory MCP server running on stdio');
  }
}

const server = new SharedMemoryMCPServer();
server.run().catch(console.error);