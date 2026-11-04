/**
 * The Windows AppUserModelID (T055): without one, Windows does not show the app's system notifications under its name.
 * It must equal `appId` in electron-builder.yml (app-id.test.ts checks), so the installed app and the running one match.
 */
export const APP_USER_MODEL_ID = 'com.firewings2515.agentworkflowgui';
