import type { z } from 'zod';
import { WorkflowTemplate } from '../../../contracts';

// Exact workflow.* keys from contracts 0.4 (d428e61:contracts/rules.ts).
export const workflowRuleMessages = {
  'workflow.node-id-unique': '節點 ID 不可重複。',
  'workflow.one-root': '請指定且只指定一個 Agent 節點作為 root。',
  'workflow.edge-missing-node': '連線的來源或目的地節點不存在，請移除此連線或補回節點。',
  'workflow.output-needs-edge': 'Output 目的地缺少連線，請重新選取目的地或建立連線。',
} as const;
type WorkflowRule = keyof typeof workflowRuleMessages;
export interface WorkflowIssue { path: string; message: string; nodeId?: string; rule?: WorkflowRule }

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

// Integration seam: replace this compatibility reader with contracts.issueRule in 0.4.
function workflowIssueRule(issue: z.core.$ZodIssue): WorkflowRule | undefined {
  const rule: unknown = issue.code === 'custom' ? issue.params?.['rule'] : undefined;
  return typeof rule === 'string' && Object.hasOwn(workflowRuleMessages, rule) ? rule as WorkflowRule : undefined;
}

export function workflowIssueMessage(issue: z.core.$ZodIssue): string {
  const rule = workflowIssueRule(issue);
  if (rule) return workflowRuleMessages[rule];
  const field = String(issue.path.at(-1) ?? '');
  if (issue.code === 'custom') {
    if (issue.path[0] === 'edges') return workflowRuleMessages['workflow.edge-missing-node'];
    if (field === 'target') return workflowRuleMessages['workflow.output-needs-edge'];
    return '流程設定不符合規則，請檢查節點、root 與連線。';
  }
  if (['concurrency', 'acceptanceLimit', 'reworkLimit', 'revision'].includes(field)) {
    return field === 'reworkLimit' ? '請輸入大於或等於 0 的整數。' : '請輸入大於或等於 1 的整數。';
  }
  if (issue.code === 'too_small') return field === 'nodes' ? '請至少新增一個節點。' : '此欄位不可空白。';
  if (issue.code === 'too_big') return '此欄位超過允許的上限。';
  if (issue.code === 'invalid_value' || issue.code === 'invalid_union') return '請選取有效的選項。';
  if (issue.code === 'unrecognized_keys') return '包含不支援的欄位，請重新載入已儲存版本。';
  if (issue.code === 'invalid_type') return '請填入有效的欄位值。';
  return '欄位格式不正確，請檢查後再儲存。';
}

// 0.3 custom graph issues have neither rule nor path. Recover locations from the
// graph invariants only when those issues occur; never inspect English messages.
function legacyGraphIssues(workflow: WorkflowTemplate): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (rule: WorkflowRule, path: string, nodeId?: string) => issues.push({ rule, path, message: workflowRuleMessages[rule], ...(nodeId ? { nodeId } : {}) });
  const ids = new Set<string>();
  workflow.nodes.forEach((node, index) => {
    if (ids.has(node.id)) add('workflow.node-id-unique', `nodes.${index}.id`, node.id);
    ids.add(node.id);
  });
  if (workflow.nodes.filter(node => node.kind === 'agent' && node.isRoot).length !== 1) add('workflow.one-root', 'nodes');
  workflow.edges.forEach((edge, index) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) add('workflow.edge-missing-node', `edges.${index}`);
  });
  workflow.nodes.forEach((node, index) => node.outputRules.forEach((rule, ruleIndex) => {
    const target = rule.target;
    if (target.kind === 'node' && !workflow.edges.some(edge => edge.source === node.id && edge.target === target.nodeId)) {
      add('workflow.output-needs-edge', `nodes.${index}.outputRules.${ruleIndex}.target`, node.id);
    }
  }));
  return issues;
}

export function workflowIssues(workflow: WorkflowTemplate): WorkflowIssue[] {
  const result = WorkflowTemplate.safeParse(workflow);
  if (result.success) return [];
  const legacy = result.error.issues.some(issue => issue.code === 'custom' && !issue.path.length && !workflowIssueRule(issue));
  return [...result.error.issues.filter(issue => !(legacy && issue.code === 'custom' && !issue.path.length && !workflowIssueRule(issue))).map(issue => {
    const node = issue.path[0] === 'nodes' && typeof issue.path[1] === 'number' ? workflow.nodes[issue.path[1]] : undefined;
    const rule = workflowIssueRule(issue);
    return { path: issue.path.map(String).join('.'), message: workflowIssueMessage(issue), ...(node ? { nodeId: node.id } : {}), ...(rule ? { rule } : {}) };
  }), ...(legacy ? legacyGraphIssues(workflow) : [])];
}
