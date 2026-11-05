/**
 * The Windows AppUserModelID (T055): without one, Windows does not show the app's system notifications under its name.
 * It must equal `appId` in electron-builder.yml (app-id.test.ts checks), so the installed app and the running one match.
 *
 * A development run (`electron .`) uses it too (T057 live): Windows silently dropped every toast of a separate ".dev"
 * ID, even with Electron's `Electron.lnk` carrying it for minutes, while this one, on the installer's shortcut, is shown.
 */
export const APP_USER_MODEL_ID = 'com.firewings2515.agentworkflowgui';

/**
 * The COM class Windows starts or calls when a notification of the installed app is clicked, from the banner or the
 * Action Center (T057). Fixed, so Electron writes the same one into the Start menu shortcut and under
 * HKCU\Software\Classes\CLSID on every run, and the uninstaller removes exactly that key (installer/installer.nsh).
 */
export const TOAST_ACTIVATOR_CLSID = '{9004B5B1-24B4-46F7-9686-C8F68B413F2D}';

/**
 * A development run's class (T057): its own, so a development run never rewrites the installed app's key (its
 * LocalServer32 would then start a development electron.exe) and the uninstaller never removes a development key.
 * Electron keeps the class already on `Electron.lnk` when that shortcut has one, so this one applies only where it has none.
 */
export const DEV_TOAST_ACTIVATOR_CLSID = '{65028196-4448-4540-B605-0E71220B2F40}';

export interface AppIdentity {
  readonly appUserModelId: string;
  readonly toastActivatorClsid: string;
}

/** The ID and the notification class of this run: the same ID for both, the installed app's class or the development one. */
export function appIdentity(isPackaged: boolean): AppIdentity {
  return { appUserModelId: APP_USER_MODEL_ID, toastActivatorClsid: isPackaged ? TOAST_ACTIVATOR_CLSID : DEV_TOAST_ACTIVATOR_CLSID };
}
