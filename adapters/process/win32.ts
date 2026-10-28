// The kernel32 calls the process host needs, through koffi (T013 approach A: the GUI main process holds
// every Job handle, so a dying GUI takes its Jobs with it). Structures are laid out by hand for 64-bit
// Windows; only this file touches native memory.
import { createRequire } from 'node:module';

/** A kernel object handle; koffi 3 passes pointers as BigInt. */
export type Handle = bigint;

const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const SW_HIDE = 0;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;

const PROCESS_TERMINATE = 0x1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;

/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116444736000000000n;

interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): Handle;
  SetInformationJobObject(job: Handle, infoClass: number, info: Buffer, length: number): number;
  QueryInformationJobObject(job: Handle, infoClass: number, info: Buffer, length: number, returned: null): number;
  AssignProcessToJobObject(job: Handle, process: Handle): number;
  IsProcessInJob(process: Handle, job: Handle, result: Buffer): number;
  TerminateJobObject(job: Handle, exitCode: number): number;
  CreateFileW(name: Buffer, access: number, share: number, security: Buffer, disposition: number, flags: number, template: null): Handle;
  InitializeProcThreadAttributeList(list: Handle | null, count: number, flags: number, size: Buffer): number;
  UpdateProcThreadAttribute(list: Handle, flags: number, attribute: bigint, value: Handle, size: bigint, previous: null, returned: null): number;
  DeleteProcThreadAttributeList(list: Handle): void;
  CreateProcessW(app: Buffer, commandLine: Buffer, pa: null, ta: null, inherit: number, flags: number, env: Buffer | null, cwd: Buffer | null, startup: Buffer, info: Buffer): number;
  ResumeThread(thread: Handle): number;
  OpenProcess(access: number, inherit: number, pid: number): Handle;
  GetProcessTimes(process: Handle, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number;
  QueryFullProcessImageNameW(process: Handle, flags: number, name: Buffer, size: Buffer): number;
  GetExitCodeProcess(process: Handle, code: Buffer): number;
  WaitForSingleObject(handle: Handle, ms: number): number;
  TerminateProcess(process: Handle, code: number): number;
  CloseHandle(handle: Handle): number;
  GetLastError(): number;
}

interface Koffi {
  load(path: string): { func(signature: string): (...args: unknown[]) => unknown };
  alloc(type: string, length: number): Handle;
  free(pointer: Handle): void;
  encode(pointer: Handle, type: string, value: unknown, length?: number): void;
}

let loaded: { k32: Kernel32; koffi: Koffi } | undefined;

/** Loads koffi and kernel32 on first use, so importing this module is harmless off Windows. */
const native = () => {
  if (loaded) return loaded;
  if (process.platform !== 'win32') throw new Error('the Job Object process host runs on Windows only');
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error(`unsupported architecture ${process.arch}`);
  const koffi = createRequire(import.meta.url)('koffi') as Koffi;
  const lib = koffi.load('kernel32.dll');
  const fns = [
    'void * __stdcall CreateJobObjectW(void *attributes, void *name)',
    'int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t length)',
    'int __stdcall QueryInformationJobObject(void *job, int infoClass, void *info, uint32_t length, void *returned)',
    'int __stdcall AssignProcessToJobObject(void *job, void *process)',
    'int __stdcall IsProcessInJob(void *process, void *job, void *result)',
    'int __stdcall TerminateJobObject(void *job, uint32_t exitCode)',
    'void * __stdcall CreateFileW(void *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)',
    'int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, void *size)',
    'int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t attribute, void *value, size_t size, void *previous, void *returned)',
    'void __stdcall DeleteProcThreadAttributeList(void *list)',
    'int __stdcall CreateProcessW(void *app, void *commandLine, void *pa, void *ta, int inherit, uint32_t flags, void *env, void *cwd, void *startup, void *info)',
    'uint32_t __stdcall ResumeThread(void *thread)',
    'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
    'int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)',
    'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, void *size)',
    'int __stdcall GetExitCodeProcess(void *process, void *code)',
    'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)',
    'int __stdcall TerminateProcess(void *process, uint32_t code)',
    'int __stdcall CloseHandle(void *handle)',
    'uint32_t __stdcall GetLastError()',
  ];
  const k32 = Object.fromEntries(fns.map((signature) => [/(\w+)\(/.exec(signature)![1], lib.func(signature)])) as unknown as Kernel32;
  loaded = { k32, koffi };
  return loaded;
};

/** Raised for a failed kernel32 call, with its Win32 error code. */
export class Win32Error extends Error {
  constructor(
    readonly call: string,
    readonly code: number,
  ) {
    super(`${call} failed with Win32 error ${code}`);
  }
}

const fail = (call: string): never => {
  throw new Win32Error(call, native().k32.GetLastError());
};

const isNull = (handle: Handle | null | undefined) => handle === null || handle === undefined || handle === 0n || handle === -1n || handle === 0xffffffffffffffffn;

const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');

export const closeHandle = (handle: Handle) => {
  native().k32.CloseHandle(handle);
};

/** A Job that kills every process in it when its last handle closes; no breakaway is allowed. */
export const createKillOnCloseJob = (): Handle => {
  const { k32 } = native();
  // No security attributes: the handle is not inheritable, so no child can keep the Job alive.
  const job = k32.CreateJobObjectW(null, null);
  if (isNull(job)) fail('CreateJobObjectW');
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes); BasicLimitInformation.LimitFlags at offset 16.
  // Neither JOB_OBJECT_LIMIT_BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is set.
  const info = Buffer.alloc(144);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length)) {
    const code = k32.GetLastError();
    k32.CloseHandle(job);
    throw new Win32Error('SetInformationJobObject', code);
  }
  return job;
};

export const terminateJob = (job: Handle, exitCode = 1) => {
  if (!native().k32.TerminateJobObject(job, exitCode)) fail('TerminateJobObject');
};

/** PIDs of the processes currently in the Job. */
export const jobProcessIds = (job: Handle): number[] => {
  const { k32 } = native();
  for (let capacity = 64; ; capacity *= 4) {
    // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids from offset 8.
    const info = Buffer.alloc(8 + capacity * 8);
    if (k32.QueryInformationJobObject(job, JobObjectBasicProcessIdList, info, info.length, null)) {
      const count = info.readUInt32LE(4);
      return Array.from({ length: count }, (_, i) => Number(info.readBigUInt64LE(8 + i * 8)));
    }
    const code = k32.GetLastError();
    // ERROR_MORE_DATA (234): a bigger buffer is needed.
    if (code !== 234) throw new Win32Error('QueryInformationJobObject', code);
  }
};

/**
 * Opens the client end of a named pipe as an inheritable handle, for one standard stream of a child.
 * Must be closed right after CreateProcessW, in the same synchronous run, so no other spawn inherits it.
 */
export const openInheritablePipe = (name: string): Handle => {
  // SECURITY_ATTRIBUTES (24 bytes): nLength, lpSecurityDescriptor at 8, bInheritHandle at 16.
  const security = Buffer.alloc(24);
  security.writeUInt32LE(24, 0);
  security.writeInt32LE(1, 16);
  const handle = native().k32.CreateFileW(wide(name), GENERIC_READ | GENERIC_WRITE, 0, security, OPEN_EXISTING, 0, null);
  if (isNull(handle)) fail('CreateFileW');
  return handle;
};

export interface CreateSuspendedOptions {
  application: string;
  commandLine: string;
  cwd?: string | undefined;
  /** UTF-16 environment block; the parent's environment when absent. */
  environment?: Buffer | undefined;
  /** stdin, stdout and stderr; the only handles the child inherits. */
  stdio: readonly [Handle, Handle, Handle];
}

export interface Created {
  process: Handle;
  thread: Handle;
  pid: number;
}

/**
 * CreateProcessW with CREATE_SUSPENDED. Through PROC_THREAD_ATTRIBUTE_HANDLE_LIST the child inherits
 * exactly the three stdio handles, never another inheritable handle of the GUI.
 */
export const createSuspended = (options: CreateSuspendedOptions): Created => {
  const { k32, koffi } = native();
  const sizeOut = Buffer.alloc(8);
  k32.InitializeProcThreadAttributeList(null, 1, 0, sizeOut);
  const listSize = Number(sizeOut.readBigUInt64LE(0));
  if (listSize === 0) fail('InitializeProcThreadAttributeList(size)');
  // The attribute list stores a pointer to the handle array, so both live in native memory until
  // CreateProcessW has run.
  const list = koffi.alloc('uint8_t', listSize);
  const handles = koffi.alloc('uint64_t', 3);
  let initialized = false;
  try {
    koffi.encode(handles, 'uint64_t', [...options.stdio], 3);
    if (!k32.InitializeProcThreadAttributeList(list, 1, 0, sizeOut)) fail('InitializeProcThreadAttributeList');
    initialized = true;
    if (!k32.UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, 24n, null, null)) fail('UpdateProcThreadAttribute');
    // STARTUPINFOEXW (112 bytes): cb, dwFlags at 60, wShowWindow at 64, std handles at 80/88/96,
    // lpAttributeList at 104.
    const startup = Buffer.alloc(112);
    startup.writeUInt32LE(112, 0);
    startup.writeUInt32LE(STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, 60);
    startup.writeUInt16LE(SW_HIDE, 64);
    startup.writeBigUInt64LE(options.stdio[0], 80);
    startup.writeBigUInt64LE(options.stdio[1], 88);
    startup.writeBigUInt64LE(options.stdio[2], 96);
    startup.writeBigUInt64LE(list, 104);
    // PROCESS_INFORMATION (24 bytes): hProcess, hThread, dwProcessId at 16.
    const info = Buffer.alloc(24);
    const flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    const ok = k32.CreateProcessW(
      wide(options.application),
      wide(options.commandLine),
      null,
      null,
      1,
      flags,
      options.environment ?? null,
      options.cwd === undefined ? null : wide(options.cwd),
      startup,
      info,
    );
    if (!ok) fail('CreateProcessW');
    return { process: info.readBigUInt64LE(0), thread: info.readBigUInt64LE(8), pid: info.readUInt32LE(16) };
  } finally {
    if (initialized) k32.DeleteProcThreadAttributeList(list);
    koffi.free(list);
    koffi.free(handles);
  }
};

export const assignToJob = (job: Handle, process: Handle) => {
  if (!native().k32.AssignProcessToJobObject(job, process)) fail('AssignProcessToJobObject');
};

/** Whether the process behind this handle is in the Job; the handle pins the process, so a PID cannot be reused under it. */
export const isProcessInJob = (process: Handle, job: Handle): boolean => {
  const result = Buffer.alloc(4);
  if (!native().k32.IsProcessInJob(process, job, result)) fail('IsProcessInJob');
  return result.readInt32LE(0) !== 0;
};

export const resumeThread = (thread: Handle) => {
  if (native().k32.ResumeThread(thread) === 0xffffffff) fail('ResumeThread');
};

/** The OS creation time of a process, as milliseconds since 1970. */
export const creationTime = (process: Handle): number => {
  const [creation, exit, kernel, user] = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
  if (!native().k32.GetProcessTimes(process, creation, exit, kernel, user)) fail('GetProcessTimes');
  return Number((creation.readBigUInt64LE(0) - FILETIME_UNIX_EPOCH) / 10000n);
};

/** Full path of the process's executable. */
export const imagePath = (process: Handle): string => {
  const name = Buffer.alloc(2 * 32768);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(32768, 0);
  if (!native().k32.QueryFullProcessImageNameW(process, 0, name, size)) fail('QueryFullProcessImageNameW');
  return name.toString('utf16le', 0, size.readUInt32LE(0) * 2);
};

/** The exit code, or undefined while the process runs. */
export const exitCodeOf = (process: Handle): number | undefined => {
  const { k32 } = native();
  const wait = k32.WaitForSingleObject(process, 0);
  if (wait === WAIT_TIMEOUT) return undefined;
  if (wait !== WAIT_OBJECT_0) fail('WaitForSingleObject');
  const code = Buffer.alloc(4);
  if (!k32.GetExitCodeProcess(process, code)) fail('GetExitCodeProcess');
  // Read only after the wait said it ended, so an exit code of 259 (STILL_ACTIVE) is a real one.
  return code.readUInt32LE(0);
};

export const terminateProcess = (process: Handle, exitCode = 1) => native().k32.TerminateProcess(process, exitCode) !== 0;

/**
 * Opens a process to compare its creation time and maybe end it, or undefined when no process has that
 * PID or it is not ours to open (a process the GUI started can always be opened by it).
 */
export const openProcess = (pid: number): Handle | undefined => {
  const { k32 } = native();
  const handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
  if (!isNull(handle)) return handle;
  const code = k32.GetLastError();
  if (code === ERROR_INVALID_PARAMETER || code === ERROR_ACCESS_DENIED) return undefined;
  throw new Win32Error('OpenProcess', code);
};
