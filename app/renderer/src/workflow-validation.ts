import type { z } from 'zod';
import { issueRule, WorkflowTemplate } from '../../../contracts';
import type { ContractRule } from '../../../contracts';

type WorkflowRule = Extract<ContractRule, `workflow.${string}`>;
export const workflowRuleMessages: Record<WorkflowRule, string> = {
  'workflow.node-id-unique': '節點 ID 不可重複。',
  'workflow.one-root': '請指定且只指定一個 Agent 節點作為 root。',
  'workflow.edge-missing-node': '連線的來源或目的地節點不存在，請移除此連線或補回節點。',
  'workflow.output-needs-edge': 'Output 目的地缺少連線，請重新選取目的地或建立連線。',
  'workflow.tasks-rule-on-root': '只有 root 節點可以有「拆分 task」的 output 規則。',
};
export interface WorkflowIssue { path: string; message: string; nodeId?: string; rule?: ContractRule }

const fieldLabels: Record<string, string> = {
  name: '範本名稱', description: '範本說明', nodes: 'Root 節點（升級對象）', isolation: 'Task 隔離', reworkLimit: '返工上限',
  id: '識別碼', label: '節點名稱', kind: '節點類型', agentId: 'Agent', model: 'Model', runtime: '工具', effort: '推理強度',
  writePolicy: '寫入權限', concurrency: '並行 task 數', isRoot: 'Root 節點', position: '畫布位置', x: '水平位置', y: '垂直位置',
  inputRules: 'Input 規則', outputRules: 'Output 規則', acceptanceLimit: '接收上限', waitForAllUpstream: '等所有上游到齊',
  payload: '送什麼', target: '目的地', nodeId: '目的地', requiresUserConfirmation: '經 root 請使用者確認',
  source: '來源節點', revision: '版本', schemaVersion: '資料格式版本', updatedAt: '更新時間',
};
export function workflowIssueLabel(workflow: WorkflowTemplate, issue: WorkflowIssue): string {
  const parts = issue.path.split('.');
  const field = parts.at(-1) ?? '';
  if (parts[0] === 'nodes' && parts.length > 1) {
    const node = workflow.nodes[Number(parts[1])];
    const name = node?.label || `節點 ${Number(parts[1]) + 1}`;
    if (parts[2] === 'inputRules' || parts[2] === 'outputRules') {
      const input = parts[2] === 'inputRules';
      const rule = `${input ? 'Input' : 'Output'}${parts[3] === undefined ? ' 規則' : ` ${Number(parts[3]) + 1}`}`;
      const label = field === 'condition' ? (input ? '收到什麼／如何處理' : '什麼情況') : fieldLabels[field];
      return [name, rule, label].filter(Boolean).join(' · ');
    }
    return `${name} · ${fieldLabels[field] ?? '節點設定'}`;
  }
  if (parts[0] === 'edges') {
    const edge = workflow.edges[Number(parts[1])];
    const name = (id: string) => workflow.nodes.find(node => node.id === id)?.label || '不存在的節點';
    return edge ? `${name(edge.source)} → ${name(edge.target)} · ${fieldLabels[field] ?? '連線'}` : '連線';
  }
  return fieldLabels[field] ?? '整體流程';
}

export function workflowIssueMessage(issue: z.core.$ZodIssue): string {
  const rule = issueRule(issue);
  const messages: Partial<Record<ContractRule, string>> = workflowRuleMessages;
  if (rule && messages[rule]) return messages[rule];
  const field = String(issue.path.at(-1) ?? '');
  if (issue.code === 'custom') {
    return '流程設定不符合規則，請檢查節點、root 與連線。';
  }
  if (['concurrency', 'acceptanceLimit', 'reworkLimit', 'revision'].includes(field)) {
    return field === 'reworkLimit' ? '請輸入大於或等於 0 的整數。' : '請輸入大於或等於 1 的整數。';
  }
  if (issue.code === 'too_small') return field === 'nodes' ? '請至少新增一個節點。' : field === 'agentId' ? '需要 Agent，請先新增 Agent 再選取。' : '此欄位不可空白。';
  if (issue.code === 'too_big') return '此欄位超過允許的上限。';
  if (issue.code === 'invalid_value' || issue.code === 'invalid_union') return '請選取有效的選項。';
  if (issue.code === 'unrecognized_keys') return '包含不支援的欄位，請重新載入已儲存版本。';
  if (issue.code === 'invalid_type') return '請填入有效的欄位值。';
  return '欄位格式不正確，請檢查後再儲存。';
}

export function workflowIssues(workflow: WorkflowTemplate): WorkflowIssue[] {
  const result = WorkflowTemplate.safeParse(workflow);
  if (result.success) return [];
  return result.error.issues.map(issue => {
    const node = issue.path[0] === 'nodes' && typeof issue.path[1] === 'number' ? workflow.nodes[issue.path[1]] : undefined;
    const rule = issueRule(issue);
    return { path: issue.path.map(String).join('.'), message: workflowIssueMessage(issue), ...(node ? { nodeId: node.id } : {}), ...(rule ? { rule } : {}) };
  });
}
