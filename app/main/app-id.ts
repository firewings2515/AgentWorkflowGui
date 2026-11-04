/**
 * The Windows AppUserModelID (T055): without one, Windows does not show the app's system notifications under its name.
 * It must equal `appId` in electron-builder.yml (app-id.test.ts checks), so the installed app and the running one match.
 */
export const APP_USER_MODEL_ID = 'com.firewings2515.agentworkflowgui';

/**
 * The COM class Windows starts or calls when a notification of the installed app is clicked, from the banner or the
 * Action Center (T057). Fixed, so Electron writes the same one into the Start menu shortcut and under
 * HKCU\Software\Classes\CLSID on every run, and the uninstaller removes exactly that key (installer/installer.nsh).
 */
export const TOAST_ACTIVATOR_CLSID = '{9004B5B1-24B4-46F7-9686-C8F68B413F2D}';

/**
 * A development run (`electron .`) has its own ID and class (T057). Electron gives it a shortcut of its own
 * (`Electron.lnk`, named after electron.exe's product name); with the installed app's ID on it too, Windows could
 * not tell which shortcut, and so which class, a click belongs to.
 */
export const DEV_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.dev`;
export const DEV_TOAST_ACTIVATOR_CLSID = '{65028196-4448-4540-B605-0E71220B2F40}';

export interface AppIdentity {
  readonly appUserModelId: string;
  readonly toastActivatorClsid: string;
}

/** The ID and the notification class of this run: the installed app's, or the development run's. */
export function appIdentity(isPackaged: boolean): AppIdentity {
  return isPackaged
    ? { appUserModelId: APP_USER_MODEL_ID, toastActivatorClsid: TOAST_ACTIVATOR_CLSID }
    : { appUserModelId: DEV_APP_USER_MODEL_ID, toastActivatorClsid: DEV_TOAST_ACTIVATOR_CLSID };
}
