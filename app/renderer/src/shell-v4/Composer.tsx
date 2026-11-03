import { useState } from 'react';
import type { AgentDefinition, ModelOption, Runtime } from '../../../../contracts';
import { Menu } from '../ui';
import { recentFolders } from './demo-data';

export type FolderChoice = { kind: 'auto' } | { kind: 'picked'; path: string };
export interface ComposerChoice { folder: FolderChoice; agentId: string; modelKey: string }

const modelKey = (model: Pick<ModelOption, 'runtime' | 'model'>) => `${model.runtime}:${model.model}`;
export const defaultModelKey = (models: readonly ModelOption[], runtime?: Runtime) => {
  const visible = models.filter(model => !model.hidden && (!runtime || model.runtime === runtime));
  const chosen = visible.find(model => model.isDefault) ?? visible[0];
  return chosen ? modelKey(chosen) : '';
};

/**
 * The input box with its chips row: attachments (WB-06, unchanged), folder, Agent, Model and send.
 * `locked` is a workflow session: its folder and Agent cannot change and only same-tool models are offered.
 */
export function Composer({ draft, onDraft, autoFolder, choice, onChoice, agents, models, placeholder, onSend, onNotice, folderFixed, locked, lockedAgent, autoFocus }: {
  draft: string; onDraft: (text: string) => void; autoFolder: string; choice: ComposerChoice; onChoice: (choice: ComposerChoice) => void;
  agents: readonly AgentDefinition[]; models: readonly ModelOption[]; placeholder: string;
  onSend: () => void; onNotice: (text: string) => void;
  /** An existing session's folder: shown, not changeable. */
  folderFixed?: string | undefined; locked?: Runtime | undefined; lockedAgent?: string | undefined; autoFocus?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const folderLabel = folderFixed ?? (choice.folder.kind === 'auto' ? `自動建立：${autoFolder}` : choice.folder.path);
  const agent = agents.find(item => item.id === choice.agentId);
  const model = models.find(item => modelKey(item) === choice.modelKey);
  const send = () => { if (draft.trim()) onSend(); };
  const visibleModels = models.filter(item => !item.hidden);
  return <form className="v4-composer" onSubmit={event => { event.preventDefault(); send(); }}>
    <label className="sr-only" htmlFor="v4-draft">{placeholder}</label>
    <textarea id="v4-draft" value={draft} rows={3} placeholder={placeholder} autoFocus={autoFocus}
      onChange={event => onDraft(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
      }} />
    <div className="v4-chips">
      <Menu label="新增附件" shortcut className="v4-chip-menu v4-plus" actions={[
        { label: 'Add files or photos', hint: 'Ctrl+U', onSelect: () => onNotice('示意模式：檔案選擇器尚未接入，未新增附件。') },
        { label: 'Add folder', onSelect: () => onNotice('示意模式：資料夾選擇器尚未接入，未新增附件。') },
      ]}>＋</Menu>
      {folderFixed ? <span className="v4-chip v4-chip-static" title={`工作資料夾：${folderFixed}`}><span aria-hidden="true">▤</span> {folderFixed}</span>
        : <Menu label={`工作資料夾：${folderLabel}`} className="v4-chip-menu v4-chip" actions={[
          { group: '工作資料夾', label: `自動建立：${autoFolder}`, hint: '預設', checked: choice.folder.kind === 'auto',
            onSelect: () => onChoice({ ...choice, folder: { kind: 'auto' } }) },
          ...recentFolders.map(path => ({ group: '最近使用', label: path, checked: choice.folder.kind === 'picked' && choice.folder.path === path,
            onSelect: () => onChoice({ ...choice, folder: { kind: 'picked', path } }) })),
          { group: '其他', label: '選擇資料夾…', onSelect: () => onNotice('示意模式：資料夾選擇器尚未接入。U2 會用 folders.request 開系統的選擇視窗。') },
        ]}><span aria-hidden="true">▤</span> {folderLabel} <span aria-hidden="true">▾</span></Menu>}
      {lockedAgent ? <span className="v4-chip v4-chip-static" title="Workflow 的 Agent 已鎖定">Agent：{lockedAgent} · 鎖定</span>
        : <Menu label={`Agent：${agent?.name ?? '無'}`} className="v4-chip-menu v4-chip" actions={[
          { group: 'Agent', label: '無', hint: '只用 Model 的預設行為', checked: !agent, onSelect: () => onChoice({ ...choice, agentId: '' }) },
          ...agents.map(item => ({ group: 'Agent', label: item.name, checked: item.id === choice.agentId, onSelect: () => onChoice({ ...choice, agentId: item.id }) })),
        ]}>Agent：{agent?.name ?? '無'} <span aria-hidden="true">▾</span></Menu>}
      <span className="v4-chip-spacer" />
      <Menu label={`Model：${model?.displayName ?? '未選擇'}`} className="v4-chip-menu v4-chip v4-model" actions={visibleModels.map(item => ({
        group: `工具：${item.runtime}`, label: item.displayName, checked: modelKey(item) === choice.modelKey,
        disabled: !!locked && item.runtime !== locked, ...(locked && item.runtime !== locked ? { title: 'workflow 的 node 不能換工具' } : {}),
        onSelect: () => onChoice({ ...choice, modelKey: modelKey(item) }),
      }))}>{model?.displayName ?? '選擇 Model'} <span aria-hidden="true">▾</span></Menu>
      <button type="submit" className="v4-send" aria-label="送出" disabled={!draft.trim()}>↑</button>
    </div>
  </form>;
}
