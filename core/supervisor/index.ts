// The idle supervisor (T036): idle runtimes closed while the app runs, resumed on demand in their original folder.
export { type BusyReason, busyReasons, type IdleFacts } from './idle';
export { type CloseCause, IdleSupervisor, SUPERVISOR_DEFAULTS, type SupervisedSessions, type SupervisorLimits, type SupervisorOptions } from './supervisor';
