export interface SharedMemoryConfig {
  // TTL configuration
  defaultTTL?: number;  // Default: 24 hours in milliseconds
  
  // Compression settings
  maxSummaryTokens?: number;  // Default: 100
  compressionRatioTarget?: number;  // Default: 0.1 (10:1)
  maxTaskDescriptionLength?: number;  // Default: 200
  
  // Performance settings
  cleanupIntervalMs?: number;  // Default: 60000 (1 minute)
  dependencyCheckIntervalMs?: number;  // Default: 100
  
  // Limits
  maxWorkersPerSession?: number;  // Default: unlimited
  maxWorkUnitsPerSession?: number;  // Default: unlimited
  maxDiscoveriesPerSession?: number;  // Default: unlimited
}

export const defaultConfig: Required<SharedMemoryConfig> = {
  defaultTTL: 24 * 60 * 60 * 1000,  // 24 hours
  maxSummaryTokens: 100,
  compressionRatioTarget: 0.1,
  maxTaskDescriptionLength: 200,
  cleanupIntervalMs: 60 * 1000,  // 1 minute
  dependencyCheckIntervalMs: 100,
  maxWorkersPerSession: 1000,
  maxWorkUnitsPerSession: 10000,
  maxDiscoveriesPerSession: 50000
};