import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentDefinition, ModelOption, Runtime } from '../../../../contracts';
import { readOnlyProps } from '../read-only';
import { Menu } from '../ui';

export type FolderChoice = { kind: 'auto' } | { kind: 'picked'; path: string };
export interface ComposerChoice { folder: FolderChoice; agentId: string; modelKey: string }

export const modelKey = (model: Pick<ModelOption, 'runtime' | 'model'>) => `${model.runtime}:${model.model}`;
export const defaultModelKey = (models: readonly ModelOption[], runtime?: Runtime) => {
  const visible = models.filter(model => !model.hidden && (!runtime || model.runtime === runtime));
  const chosen = visible.find(model => model.isDefault) ?? visible[0];
  return chosen ? modelKey(chosen) : '';
};

/** A new chat's folder chip (U2_PLAN §3-3): 自動建立 without a number (Q-11), recent folders, or the system picker. */
export interface FolderOptions { recent: readonly string[]; onPick: () => void }

/**
 * The input box with its chips row: attachments (WB-06, unchanged), folder, Agent, Model and send.
 * `folderFixed` is an existing session's folder. `locked` is a workflow session: its Agent is fixed and only
 * same-tool models are offered. `transferFrom` is an ordinary session: another tool's model starts a transfer.
 */
export function Composer({ draft, onDraft, choice, onChoice, agents, models, placeholder, onSend, onNotice, folderFixed, folders, locked, lockedAgent, transferFrom, attachTarget = '新對話',
  autoFocus, readOnly = false, sendDisabled = false, inputDisabled = false, choiceDisabled = false, children }: {
  draft: string; onDraft: (text: string) => void; choice: ComposerChoice; onChoice: (choice: ComposerChoice) => void;
  agents: readonly AgentDefinition[]; models: readonly ModelOption[]; placeholder: string;
  onSend: () => void; onNotice: (text: string) => void;
  /** Where attachments would go (WB-06): named in the notice while the pickers are not connected. */
  attachTarget?: string;
  folderFixed?: string | undefined; folders?: FolderOptions | undefined;
  locked?: Runtime | undefined; lockedAgent?: string | undefined; transferFrom?: Runtime | undefined;
  autoFocus?: boolean; readOnly?: boolean;
  /** Sending is not possible now; the reason is one of the status lines passed as children. The draft stays. */
  sendDisabled?: boolean;
  /** While a new chat is being created the text cannot change, so the message sent is the one the user saw. */
  inputDisabled?: boolean;
  /** The Agent and Model cannot change now (read-only, not synchronised, or a change is in flight). */
  choiceDisabled?: boolean;
  children?: ReactNode;
}) {
  const [composing, setComposing] = useState(false);
  // One composer per pane: the label must point at its own text box.
  const inputId = useId();
  const folderLabel = folderFixed ?? (choice.folder.kind === 'auto' ? '自動建立' : choice.folder.path);
  const agent = agents.find(item => item.id === choice.agentId);
  const model = models.find(item => modelKey(item) === choice.modelKey);
  const blocked = sendDisabled || readOnly || inputDisabled;
  const send = () => { if (draft.trim() && !blocked) onSend(); };
  const visibleModels = models.filter(item => !item.hidden);
  const disabledChoice = choiceDisabled || readOnly ? { disabled: true, ...readOnlyProps(readOnly) } : {};
  const picked = choice.folder.kind === 'picked' ? choice.folder.path : undefined;
  const recent = folders ? [...(picked && !folders.recent.includes(picked) ? [picked] : []), ...folders.recent] : [];
  return <form className="v4-composer" onSubmit={event => { event.preventDefault(); send(); }}>
    <label className="sr-only" htmlFor={inputId}>{placeholder}</label>
    <textarea id={inputId} value={draft} rows={3} placeholder={placeholder} autoFocus={autoFocus} readOnly={inputDisabled}
      onChange={event => onDraft(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
      }} />
    <div className="v4-chips">
      <Menu label="新增附件" shortcut className="v4-chip-menu v4-plus" actions={[
        { label: 'Add files or photos', hint: 'Ctrl+U', onSelect: () => onNotice(`附件目標：${attachTarget}。檔案／照片選擇器尚未接入；未讀取檔案，也未新增附件。`) },
        { label: 'Add folder', onSelect: () => onNotice(`附件目標：${attachTarget}。資料夾選擇器尚未接入；未讀取檔案，也未新增附件。`) },
      ]}>＋</Menu>
      {folderFixed !== undefined || !folders ? <span className="v4-chip v4-chip-static" title={`工作資料夾：${folderLabel}`}><span aria-hidden="true">▤</span> {folderLabel}</span>
        : <Menu label={`工作資料夾：${folderLabel}`} className="v4-chip-menu v4-chip" actions={[
          { group: '工作資料夾', label: '自動建立', hint: '預設', checked: choice.folder.kind === 'auto', ...disabledChoice,
            onSelect: () => onChoice({ ...choice, folder: { kind: 'auto' } }) },
          ...recent.map(path => ({ group: '最近使用', label: path, checked: picked === path, ...disabledChoice,
            onSelect: () => onChoice({ ...choice, folder: { kind: 'picked' as const, path } }) })),
          { group: '其他', label: '選擇資料夾…', ...disabledChoice, onSelect: folders.onPick },
        ]}><span aria-hidden="true">▤</span> {folderLabel} <span aria-hidden="true">▾</span></Menu>}
      {lockedAgent ? <span className="v4-chip v4-chip-static" title="Workflow 的 Agent 已鎖定；更換 Agent 請建立新 Workflow">Agent：{lockedAgent} · 鎖定</span>
        : <Menu label={`Agent：${agent?.name ?? (choice.agentId ? '已移除' : '無')}`} className="v4-chip-menu v4-chip" actions={[
          { group: 'Agent', label: '無', hint: '只用 Model 的預設行為', checked: !choice.agentId, ...disabledChoice, onSelect: () => onChoice({ ...choice, agentId: '' }) },
          ...agents.map(item => ({ group: 'Agent', label: item.name, checked: item.id === choice.agentId, ...disabledChoice, onSelect: () => onChoice({ ...choice, agentId: item.id }) })),
        ]}>Agent：{agent?.name ?? (choice.agentId ? '已移除' : '無')} <span aria-hidden="true">▾</span></Menu>}
      <span className="v4-chip-spacer" />
      <Menu label={`Model：${model?.displayName ?? '未選擇'}`} className="v4-chip-menu v4-chip v4-model" actions={visibleModels.map(item => {
        const crossLocked = !!locked && item.runtime !== locked;
        const transfer = !!transferFrom && item.runtime !== transferFrom;
        return {
          group: `工具：${item.runtime}`, label: item.displayName, checked: modelKey(item) === choice.modelKey, ...disabledChoice,
          ...(transfer ? { hint: '轉交' } : {}),
          ...(crossLocked ? { disabled: true, title: 'workflow 的 node 不能換工具' } : {}),
          onSelect: () => onChoice({ ...choice, modelKey: modelKey(item) }),
        };
      })}>{model?.displayName ?? '選擇 Model'} <span aria-hidden="true">▾</span></Menu>
      <button type="submit" className="v4-send" aria-label="送出" {...readOnlyProps(readOnly)} disabled={!draft.trim() || blocked}>↑</button>
    </div>
    {children && <div className="v4-composer-status">{children}</div>}
  </form>;
}
