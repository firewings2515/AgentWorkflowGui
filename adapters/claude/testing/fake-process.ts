// A stand-in for claude.exe as `spawnClaudeCodeProcess` returns it (tests only, T035): it exits when the
// test says so, or on kill() once `exitOnKill` is set.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { WireSpawnedProcess } from '../wire';

export class FakeProcess extends EventEmitter implements WireSpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  kills = 0;
  exitOnKill = false;
  /** What kill() answers: false is a kill that failed. */
  killWorks = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    this.kills++;
    if (!this.killWorks) return false;
    this.killed = true;
    if (this.exitOnKill) setTimeout(() => this.exit(1), 5);
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}
