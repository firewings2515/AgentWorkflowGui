// The settings page (T045). The theme stays in the header and the menu; this page starts with Runtime.
import type { Snapshot } from '../../../contracts';
import type { RendererState, RendererStore } from './renderer-store';
import { RuntimePanel } from './RuntimePanel';

export function SettingsPage({ snapshot, store, ipcState }: { snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined }) {
  return <section className="settings-page" aria-label="設定">
    <h2 className="settings-heading">Runtime</h2>
    <RuntimePanel snapshot={snapshot} store={store} ipcState={ipcState} />
  </section>;
}
