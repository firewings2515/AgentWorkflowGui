// Versioned commands / events / DTOs shared by renderer, core and adapters (T002).
// Bump CONTRACTS_VERSION on any breaking change; contract changes go through the main session.
export const CONTRACTS_VERSION = '0.1.0';

export * from './common';
export * from './agent';
export * from './session';
export * from './workflow';
export * from './transfer';
export * from './ipc';
