import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentDefinition, Snapshot, WorkflowTemplate } from '../../../../contracts';
import { SettingsPage } from '../SettingsPage';
import type { Theme } from '../theme';
import { Composer } from './Composer';
import type { ComposerChoice } from './Composer';
import { defaultFolderRoot, recentFolders } from './demo-data';

/** Claude's blank conversation: one prompt line and the input box. The session is created only on send (Q-3). */
export function NewChat({ snapshot, agents, draft, onDraft, choice, onChoice, autoFolder, onNotice }: {
  snapshot: Snapshot; agents: readonly AgentDefinition[]; draft: string; onDraft: (text: string) => void;
  choice: ComposerChoice; onChoice: (choice: ComposerChoice) => void; autoFolder: string; onNotice: (text: string) => void;
}) {
  return <section className="v4-new-chat" aria-labelledby="v4-new-heading">
    <div className="v4-column">
      <h1 id="v4-new-heading" tabIndex={-1}>今天想做什麼？</h1>
      <Composer draft={draft} onDraft={onDraft} choice={choice} onChoice={onChoice} agents={agents} models={snapshot.modelOptions} autoFolder={autoFolder} autoFocus
        placeholder="輸入訊息，送出後才建立對話…" onNotice={onNotice}
        onSend={() => onNotice(`示意模式：未連接 runtime，草稿已保留。U2 會依序送 session.create 與 session.send（資料夾：${choice.folder.kind === 'auto' ? `在 ${defaultFolderRoot} 下自動建立 ${autoFolder}` : choice.folder.path}）。`)} />
      <p className="v4-hint">沒選資料夾時，送出會在 <code>{defaultFolderRoot}</code> 建立新的資料夾。Agent 可以不選。</p>
    </div>
  </section>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="v4-field"><span className="v4-field-label">{label}</span>{children}{hint && <p className="v4-muted v4-field-hint">{hint}</p>}</div>;
}

export function SettingsV4({ snapshot, theme, onTheme, onNotice }: { snapshot: Snapshot; theme: Theme; onTheme: (theme: Theme) => void; onNotice: (text: string) => void }) {
  const [root, setRoot] = useState(defaultFolderRoot);
  return <section className="v4-page" aria-labelledby="v4-settings-heading">
    <div className="v4-page-column">
      <h1 id="v4-settings-heading" tabIndex={-1}>設定</h1>
      <section className="v4-card" aria-label="一般">
        <h2>一般</h2>
        <Field label="外觀"><div className="v4-segmented" role="radiogroup" aria-label="外觀">
          {(['dark', 'light'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => onTheme(value)}>{value === 'dark' ? '深色' : '淺色'}</button>)}
        </div></Field>
        <Field label="預設工作資料夾位置" hint={<>新對話沒選資料夾時，會在這裡建立「日期加序號」的資料夾，例如 <code>2026-11-04-001</code>。只有真的送出時才建立。</>}>
          <div className="v4-inline-field">
            <input aria-label="預設工作資料夾位置" value={root} onChange={event => setRoot(event.target.value)} />
            <button type="button" onClick={() => onNotice('示意模式：資料夾選擇器尚未接入。')}>選擇…</button>
            <button type="button" disabled={root === defaultFolderRoot} onClick={() => setRoot(defaultFolderRoot)}>還原預設</button>
          </div>
        </Field>
        <div className="v4-card-actions"><button type="button" className="primary" disabled={!root.trim()} onClick={() => onNotice(`示意模式：未儲存。U2 會把「${root.trim()}」寫進偏好設定。`)}>儲存</button></div>
      </section>
      <section className="v4-runtime" aria-label="Runtime"><SettingsPage snapshot={snapshot} store={undefined} ipcState={undefined} /></section>
    </div>
  </section>;
}

/** Workflow start with the two folders of Q-4／Q-8: where the outputs go, and the repo the task worktrees come from. */
export function WorkflowStartV4({ snapshot, autoFolder, onNotice }: { snapshot: Snapshot; autoFolder: string; onNotice: (text: string) => void }) {
  const [template, setTemplate] = useState<WorkflowTemplate | undefined>(snapshot.workflows[0]);
  const [title, setTitle] = useState('');
  const [work, setWork] = useState('');
  const [project, setProject] = useState('');
  const [message, setMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const worktree = template?.isolation === 'worktree';
  const crossTool = new Set(template?.nodes.flatMap(node => node.kind === 'agent' ? [node.model.runtime] : [])).size > 1;
  const ready = !!template && !!title.trim() && !!message.trim() && (!worktree || !!project.trim()) && (!crossTool || consent);
  return <section className="v4-page" aria-labelledby="v4-start-heading">
    <form className="v4-page-column" onSubmit={event => {
      event.preventDefault();
      if (ready) onNotice(`示意模式：未啟動。U2 會送 workflow.start（工作資料夾：${work.trim() || `自動建立 ${autoFolder}`}；專案資料夾：${project.trim() || '不使用'}）。`);
    }}>
      <h1 id="v4-start-heading" tabIndex={-1}>開始 Workflow</h1>
      <section className="v4-card" aria-label="範本">
        <Field label="Workflow 範本"><select aria-label="Workflow 範本" value={template?.id ?? ''} onChange={event => { setTemplate(snapshot.workflows.find(item => item.id === event.target.value)); setConsent(false); }}>
          {snapshot.workflows.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}
        </select></Field>
        {template && <p className="v4-muted">{template.isolation === 'same-folder' ? '同資料夾模式：所有 node 在工作資料夾裡做，不用專案資料夾。' : 'Worktree 模式：每個 task 從專案資料夾開自己的 worktree，合併回專案資料夾。'} {template.description}</p>}
        <Field label="標題"><input aria-label="標題" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：登入功能" /></Field>
      </section>
      <section className="v4-card" aria-label="資料夾">
        <h2>資料夾</h2>
        <div className="v4-two-col">
          <Field label="工作資料夾（可不選）" hint="放報告、計畫、紀錄。沒選就在預設位置自動建立。">
            <div className="v4-inline-field"><input aria-label="工作資料夾" value={work} onChange={event => setWork(event.target.value)} placeholder={`自動建立：${autoFolder}`} list="v4-recent-folders" />
              <button type="button" onClick={() => onNotice('示意模式：資料夾選擇器尚未接入。')}>選擇…</button></div>
          </Field>
          <Field label={worktree ? '專案資料夾（必選）' : '專案資料夾（這個範本不用）'} hint={worktree ? '程式碼所在的 git repo；task 的 worktree 從這裡開，合併也回到這裡。' : '同資料夾模式直接在工作資料夾裡做。'}>
            <div className="v4-inline-field"><input aria-label="專案資料夾" aria-required={worktree} value={project} disabled={!worktree} onChange={event => setProject(event.target.value)} placeholder={worktree ? '選擇 git repo' : '不需要'} list="v4-recent-folders" />
              <button type="button" disabled={!worktree} onClick={() => onNotice('示意模式：資料夾選擇器尚未接入。')}>選擇…</button></div>
          </Field>
        </div>
        <datalist id="v4-recent-folders">{recentFolders.map(path => <option key={path} value={path} />)}</datalist>
      </section>
      <section className="v4-card" aria-label="第一則訊息">
        <Field label="第一則訊息（給 root）"><textarea aria-label="第一則訊息" rows={4} value={message} onChange={event => setMessage(event.target.value)} placeholder="說明要做什麼、驗收條件…" /></Field>
        {crossTool && <label className="v4-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我同意此版本、此執行群組內的跨工具交接（handoff、send_message、report_to_root）。</label>}
        <div className="v4-card-actions"><span className="v4-muted">{worktree && !project.trim() ? '還沒選專案資料夾' : ''}</span><button type="submit" className="primary" disabled={!ready}>開始</button></div>
      </section>
    </form>
  </section>;
}
