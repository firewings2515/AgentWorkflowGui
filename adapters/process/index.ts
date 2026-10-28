// Windows Job Object process host (T013): ProcessHost for core, spawn functions for the adapters.
export { commandLine, environmentBlock, quoteArg, resolveExecutable } from './command-line';
export { WindowsProcessHost, type WindowsProcessHostOptions } from './host';
export { JobChild, type LaunchOptions, launchInJob } from './launch';
export { type AppServerSpawnOptions, type ClaudeProcessSpawnOptions, claudeProcessSpawn, codexAppServerSpawn, type JobSpawner } from './runtimes';
export { Win32Error } from './win32';
