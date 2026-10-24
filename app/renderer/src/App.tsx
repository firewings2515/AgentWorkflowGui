import { useEffect, useState } from 'react';

export const APP_NAME = 'AgentWorkflowGui';

export function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void window.awg?.getAppInfo().then((info) => {
      setVersion(info.version);
    });
  }, []);

  return (
    <main>
      <h1>{APP_NAME}</h1>
      {version !== null && <p>v{version}</p>}
    </main>
  );
}
