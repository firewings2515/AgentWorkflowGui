import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Snapshot } from '../../../contracts';
import { fixtureReadOnlySnapshot } from '../../../contracts/fixtures/snapshot';
import { ConnectionStatus } from './ConnectionStatus';
import { performanceSnapshot } from './performance-demo';
import { createStorageDemo } from './query-bridge';
import { createRendererStore, rendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { v4DemoSnapshot } from './shell-v4/demo-data';
import { APP_NAME, ShellV4 } from './shell-v4/ShellV4';
import './styles.css';

export { APP_NAME } from './shell-v4/ShellV4';
export { THEME_KEY } from './theme';

/**
 * The app is the v0.4 shell (U2_PLAN §3 T051, Q-10: no way back to the old screens). Connected to the app service it
 * shows the service's data and sends real commands; without it, a demo of fixture data (`?demo=long`: a 2000-turn
 * conversation, `?demo=read-only`: read-only data) that never sends runtime commands.
 */
export function App({ snapshot }: { snapshot?: Snapshot }) {
  const demo = new URLSearchParams(window.location.search).get('demo');
  return window.awg ? <ConnectedApp store={rendererStore(window.awg)} />
    : <DemoApp snapshot={snapshot ?? (demo === 'long' ? performanceSnapshot() : demo === 'read-only' ? fixtureReadOnlySnapshot : v4DemoSnapshot)} />;
}

function DemoApp({ snapshot }: { snapshot: Snapshot }) {
  const serviceStore = useMemo(() => createRendererStore(createStorageDemo(snapshot)), [snapshot]);
  const state = useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot);
  useEffect(() => { void serviceStore.start(); return () => serviceStore.dispose(); }, [serviceStore]);
  return <ShellV4 snapshot={state.snapshot ?? snapshot} serviceStore={serviceStore} />;
}

function ConnectedApp({ store }: { store: RendererStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.start();
    const reconnect = () => { void store.reconnect(); };
    window.addEventListener('online', reconnect);
    return () => { window.removeEventListener('online', reconnect); store.dispose(); };
  }, [store]);
  if (!state.snapshot) return <div className="connection-screen"><h1>{APP_NAME}</h1><ConnectionStatus state={state} store={store} /></div>;
  return <ShellV4 snapshot={state.snapshot} store={store} serviceStore={store} ipcState={state} />;
}
