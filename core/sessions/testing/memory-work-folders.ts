// A memory file system for the work folders (T048): folders and the files put in them, compared without case like
// Windows. `onMake` runs before a folder is made (a test can make the same name first, as another program would).
import type { WorkFolderFs } from '../../ports';

const key = (path: string) => path.replace(/[\\/]+$/, '').toLowerCase();
const parentKey = (path: string) => key(path).replace(/[\\/][^\\/]*$/, '');

export class MemoryWorkFolderFs implements WorkFolderFs {
  readonly folders = new Map<string, string>();
  readonly files = new Set<string>();
  /** Every folder made through `make` / `makeTree`, in order (as written). */
  readonly made: string[] = [];
  onMake: ((path: string) => void) | undefined;

  constructor(existing: readonly string[] = []) {
    for (const folder of existing) this.makeTree(folder);
    this.made.length = 0;
  }

  exists(path: string): boolean {
    return this.folders.has(key(path));
  }

  /** A file in a folder (the user put something in it). */
  putFile(path: string): void {
    this.files.add(key(path));
  }

  list(folder: string): string[] {
    if (!this.exists(folder)) return [];
    const prefix = `${key(folder)}\\`;
    const names = [...this.folders.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\')).map(([, p]) => p.replace(/^.*[\\/]/, ''));
    const files = [...this.files].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\')).map((k) => k.slice(prefix.length));
    return [...names, ...files];
  }

  makeTree(folder: string): void {
    const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('\\');
      if (i === 1 || this.exists(path)) continue;
      if (this.files.has(key(path))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      this.folders.set(key(path), path);
      this.made.push(path);
    }
  }

  make(folder: string): 'created' | 'exists' {
    this.onMake?.(folder);
    if (this.exists(folder) || this.files.has(key(folder))) return 'exists';
    const parent = parentKey(folder);
    if (parent.includes('\\') && !this.folders.has(parent)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    this.folders.set(key(folder), folder.replace(/[\\/]+$/, ''));
    this.made.push(folder);
    return 'created';
  }

  /** The user removes a folder (and what is in it) outside the GUI. */
  removeByUser(folder: string): void {
    const prefix = key(folder);
    for (const k of [...this.folders.keys()]) if (k === prefix || k.startsWith(`${prefix}\\`)) this.folders.delete(k);
    for (const k of [...this.files]) if (k.startsWith(`${prefix}\\`)) this.files.delete(k);
  }
}
