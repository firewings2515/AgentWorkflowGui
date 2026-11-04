// T057: the Windows ID and notification class of the installed app and of a development run, and the uninstaller's key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_USER_MODEL_ID, appIdentity, DEV_APP_USER_MODEL_ID, DEV_TOAST_ACTIVATOR_CLSID, TOAST_ACTIVATOR_CLSID } from './app-id';

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;
const root = join(__dirname, '../..');

describe('T057 app identity', () => {
  it('both classes are brace-wrapped GUIDs, and the two runs differ in ID and class', () => {
    expect(TOAST_ACTIVATOR_CLSID).toMatch(GUID);
    expect(DEV_TOAST_ACTIVATOR_CLSID).toMatch(GUID);
    expect(DEV_TOAST_ACTIVATOR_CLSID).not.toBe(TOAST_ACTIVATOR_CLSID);
    expect(DEV_APP_USER_MODEL_ID).not.toBe(APP_USER_MODEL_ID);
  });

  it('a packaged app takes the installer’s ID (its appId) and class; a development run the .dev ones', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(appIdentity(true)).toEqual({ appUserModelId: /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1], toastActivatorClsid: TOAST_ACTIVATOR_CLSID });
    expect(appIdentity(false)).toEqual({ appUserModelId: `${APP_USER_MODEL_ID}.dev`, toastActivatorClsid: DEV_TOAST_ACTIVATOR_CLSID });
  });

  it('the uninstaller removes exactly the installed app’s class key, named in full, and nothing else from the registry', () => {
    const nsh = readFileSync(join(root, 'installer/installer.nsh'), 'utf8');
    const deletes = nsh.split(/\r?\n/).filter(line => /\b(DeleteReg|WriteReg)/i.test(line) && !line.trim().startsWith(';'));
    expect(deletes.map(line => line.trim())).toEqual([`DeleteRegKey HKCU "Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}"`]);
    expect(nsh).toMatch(/!macro customUnInstall\r?\n {2}\$\{ifNot\} \$\{isUpdated\}\r?\n {4}DeleteRegKey/);
    expect(nsh).not.toContain(DEV_TOAST_ACTIVATOR_CLSID);
    expect(nsh).not.toContain('*');
  });
});
