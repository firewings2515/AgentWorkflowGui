// Same-folder file locks (T033, R-07): the lock table and what puts it to work.
export { type AbortLike, type FileState, isWriteRequest, LockCoordinator, type LockCoordinatorOptions, type LockEscalation, type LockStep } from './coordinator';
export { foldPath, isIgnoredChange, isInside, lockPath } from './paths';
export { type LockTableOptions, MemoryLockTable } from './table';
