import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { SharedMemoryConfig } from './config';

export class ValidationError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
  }
}

export function validateSessionId(sessionId: string | undefined): void {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ValidationError('Session ID is required and must be a non-empty string');
  }
}

export function validateWorkerId(workerId: string | undefined): void {
  if (!workerId || typeof workerId !== 'string' || workerId.trim() === '') {
    throw new ValidationError('Worker ID is required and must be a non-empty string');
  }
}

export function validateWorkerIds(workerIds: string[] | undefined, config: SharedMemoryConfig): void {
  if (!Array.isArray(workerIds)) {
    throw new ValidationError('Worker IDs must be an array');
  }
  
  if (workerIds.length === 0) {
    throw new ValidationError('At least one worker ID is required');
  }
  
  if (config.maxWorkersPerSession && workerIds.length > config.maxWorkersPerSession) {
    throw new ValidationError(`Cannot exceed ${config.maxWorkersPerSession} workers per session`);
  }
  
  const uniqueWorkers = new Set(workerIds);
  if (uniqueWorkers.size !== workerIds.length) {
    throw new ValidationError('Worker IDs must be unique');
  }
  
  workerIds.forEach(validateWorkerId);
}

export function validateUnitId(unitId: string | undefined): void {
  if (!unitId || typeof unitId !== 'string' || unitId.trim() === '') {
    throw new ValidationError('Unit ID is required and must be a non-empty string');
  }
}

export function validateWorkUnits(workUnits: any[] | undefined, config: SharedMemoryConfig): void {
  if (!Array.isArray(workUnits)) {
    throw new ValidationError('Work units must be an array');
  }
  
  if (config.maxWorkUnitsPerSession && workUnits.length > config.maxWorkUnitsPerSession) {
    throw new ValidationError(`Cannot exceed ${config.maxWorkUnitsPerSession} work units per session`);
  }
  
  const unitIds = new Set<string>();
  
  workUnits.forEach((unit, index) => {
    if (!unit || typeof unit !== 'object') {
      throw new ValidationError(`Work unit at index ${index} must be an object`);
    }
    
    validateUnitId(unit.unit_id);
    
    if (unitIds.has(unit.unit_id)) {
      throw new ValidationError(`Duplicate work unit ID: ${unit.unit_id}`);
    }
    unitIds.add(unit.unit_id);
    
    if (!unit.type || typeof unit.type !== 'string') {
      throw new ValidationError(`Work unit ${unit.unit_id} must have a type`);
    }
    
    if (!unit.description || typeof unit.description !== 'string') {
      throw new ValidationError(`Work unit ${unit.unit_id} must have a description`);
    }
    
    if (!['low', 'medium', 'high'].includes(unit.priority)) {
      throw new ValidationError(`Work unit ${unit.unit_id} must have priority: low, medium, or high`);
    }
    
    if (unit.dependencies && !Array.isArray(unit.dependencies)) {
      throw new ValidationError(`Work unit ${unit.unit_id} dependencies must be an array`);
    }
  });
}

export function validateDiscoveryType(type: string | undefined): void {
  const validTypes = ['function_found', 'dependency_identified', 'error_pattern', 'optimization_opportunity', 'requirement_clarification'];
  if (!type || !validTypes.includes(type)) {
    throw new ValidationError(`Discovery type must be one of: ${validTypes.join(', ')}`);
  }
}

export function validateSessionStatus(status: string | undefined): void {
  const validStatuses = ['planning', 'executing', 'consolidating', 'complete'];
  if (!status || !validStatuses.includes(status)) {
    throw new ValidationError(`Session status must be one of: ${validStatuses.join(', ')}`);
  }
}

export function validateWorkStatus(status: string | undefined): void {
  const validStatuses = ['in_progress', 'completed', 'blocked'];
  if (!status || !validStatuses.includes(status)) {
    throw new ValidationError(`Work status must be one of: ${validStatuses.join(', ')}`);
  }
}

export function validatePositiveNumber(value: number | undefined, fieldName: string): void {
  if (value === undefined || value === null || typeof value !== 'number' || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive number`);
  }
}

export function validateOutputKeys(keys: string[] | undefined): void {
  if (!Array.isArray(keys)) {
    throw new ValidationError('Output keys must be an array');
  }
  
  if (keys.length === 0) {
    throw new ValidationError('At least one output key is required');
  }
  
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    throw new ValidationError('Output keys must be unique');
  }
  
  keys.forEach(key => {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new ValidationError('Each output key must be a non-empty string');
    }
  });
}