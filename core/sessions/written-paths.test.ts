// What a session wrote (PolicyContext.writtenPaths, T017 plan §4 as decided by the main session).
import { describe, expect, it } from 'vitest';
import { WrittenPaths, absolutePath } from './written-paths';

const ROOT = 'E:\\ws';

describe('WrittenPaths', () => {
  it('keeps exact paths, taking relative ones against the cwd', () => {
    const w = new WrittenPaths();
    w.add('s', ['src\\a.py', 'E:\\other\\b.txt'], 'E:\\ws\\');
    expect(w.list('s')).toEqual(['E:\\ws\\src\\a.py', 'E:\\other\\b.txt']);
    expect(absolutePath('/x', 'E:\\ws')).toBe('/x');
    expect(w.list('other')).toEqual([]);
  });

  it('records watched files one by one, .git included, and ignores changes outside the workspace', () => {
    const w = new WrittenPaths();
    w.changed('s', ROOT, `${ROOT}\\.git\\hooks\\pre-commit`);
    w.changed('s', ROOT, `${ROOT}\\run.ps1`);
    w.changed('s', ROOT, 'E:\\elsewhere\\x.ps1');
    expect(w.list('s')).toEqual([`${ROOT}\\.git\\hooks\\pre-commit`, `${ROOT}\\run.ps1`]);
  });

  it('records the outermost folder below the workspace as a whole once more than the limit changed under it', () => {
    const w = new WrittenPaths({ folderLimit: 3, totalLimit: 100 });
    for (let i = 0; i < 2; i++) w.changed('s', ROOT, `${ROOT}\\node_modules\\a\\f${i}.js`);
    for (let i = 0; i < 2; i++) w.changed('s', ROOT, `${ROOT}\\node_modules\\b\\lib\\f${i}.js`);
    w.changed('s', ROOT, `${ROOT}\\src\\main.ts`);
    expect(w.list('s')).toEqual([`${ROOT}\\node_modules`, `${ROOT}\\src\\main.ts`]);
    // Further changes inside it add nothing; the rest of the workspace is still file by file.
    w.changed('s', ROOT, `${ROOT}\\NODE_MODULES\\c\\x.js`);
    expect(w.list('s')).toEqual([`${ROOT}\\node_modules`, `${ROOT}\\src\\main.ts`]);
  });

  it('counts the whole workspace as written past the total limit', () => {
    const w = new WrittenPaths({ folderLimit: 100, totalLimit: 3 });
    for (let i = 0; i < 4; i++) w.changed('s', ROOT, `${ROOT}\\f${i}.txt`);
    expect(w.list('s')).toEqual([ROOT]);
    w.changed('s', ROOT, `${ROOT}\\later.txt`);
    expect(w.list('s')).toEqual([ROOT]);
  });

  it('fails closed when the watch fails: the workspace counts as written, exact paths stay', () => {
    const w = new WrittenPaths();
    w.add('s', ['E:\\ws\\a.py'], ROOT);
    w.changed('s', ROOT, `${ROOT}\\b.py`);
    w.wholeWorkspace('s', ROOT);
    expect(w.list('s')).toEqual(['E:\\ws\\a.py', ROOT]);
  });
});
