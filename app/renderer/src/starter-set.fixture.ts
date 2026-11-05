// T063: the starter set as core/workflow/starter.ts makes it (no model listed yet, at a fixed time), for the renderer's
// tests, which may not load the core. tests/t063-starter.test.ts checks that the core still makes exactly this.
import { AgentDefinition, CONTRACTS_VERSION, WorkflowTemplate } from '../../../contracts';

export const STARTER_FIXTURE_TIME = '2026-11-06T00:00:00.000Z';
const agents = [
  {
    "id": "starter-agent-plan",
    "revision": 0,
    "name": "規劃",
    "description": "拆解工作、建立 task",
    "instructions": "你是規劃者。先弄清楚使用者要的結果和限制，有不清楚的地方先問。\n把工作拆成小而獨立的 task：每個 task 寫清楚要改的範圍、完成條件，以及依賴哪些 task。\ntask 清單先交給使用者確認，確認後再把 task 交給實作。\n收到審查回報時，判斷要返工還是完成：需要返工就把問題整理成具體的修改項目交回實作；全部通過就向使用者總結結果。\n你不直接修改程式碼。",
    "updatedAt": "2026-11-06T00:00:00.000Z"
  },
  {
    "id": "starter-agent-implement",
    "revision": 0,
    "name": "實作",
    "description": "照 task 修改程式",
    "instructions": "你是實作者。只做交給你的 task，不擴大範圍。\n動手前先讀相關程式碼，照專案既有的寫法修改。改完執行相關的測試或檢查。\n完成後交給審查，說明改了哪些檔案、怎麼做、測試結果，以及沒做完或不確定的地方。\n遇到需求不清楚或做不到時，不要猜，說明原因交回規劃。",
    "updatedAt": "2026-11-06T00:00:00.000Z"
  },
  {
    "id": "starter-agent-review",
    "revision": 0,
    "name": "審查",
    "description": "檢查實作，回報問題",
    "instructions": "你是審查者。檢查實作是否符合 task 的完成條件，找出錯誤、遺漏和風險。\n只讀不改：不修改任何檔案。\n回報給規劃：先寫結論（通過或需要修改），再逐條列出問題，附上檔案位置和建議的改法。\n沒有發現問題時直接說通過，不要硬找問題。",
    "updatedAt": "2026-11-06T00:00:00.000Z"
  }
];
const workflow = {
  "id": "starter-workflow-plan-implement-review",
  "revision": 0,
  "name": "規劃 → 實作 → 審查",
  "description": "規劃拆解 task，實作照 task 修改，審查檢查後回報規劃。",
  "reworkLimit": 2,
  "isolation": "same-folder",
  "nodes": [
    {
      "id": "starter-node-plan",
      "label": "規劃",
      "writePolicy": "write",
      "concurrency": 1,
      "inputRules": [],
      "outputRules": [
        {
          "id": "plan-tasks",
          "condition": "工作拆解完成，列出 task 清單時",
          "payload": "每個 task 的標題、範圍、完成條件和依賴",
          "target": {
            "kind": "tasks"
          },
          "requiresUserConfirmation": true
        },
        {
          "id": "plan-implement",
          "condition": "task 已確認，可以交給實作時（含返工）",
          "payload": "這個 task 要做什麼、相關檔案、完成條件；返工時附上審查的問題",
          "target": {
            "kind": "node",
            "nodeId": "starter-node-implement"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 0,
        "y": 120
      },
      "kind": "agent",
      "agentId": "starter-agent-plan",
      "model": {
        "runtime": "claude",
        "model": "sonnet"
      },
      "isRoot": true
    },
    {
      "id": "starter-node-implement",
      "label": "實作",
      "writePolicy": "write",
      "concurrency": 1,
      "inputRules": [],
      "outputRules": [
        {
          "id": "implement-review",
          "condition": "實作完成、檢查跑過時",
          "payload": "改了哪些檔案、做法摘要、測試或檢查結果、未完成的地方",
          "target": {
            "kind": "node",
            "nodeId": "starter-node-review"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 230,
        "y": 120
      },
      "kind": "agent",
      "agentId": "starter-agent-implement",
      "model": {
        "runtime": "codex",
        "model": "gpt-6.1-sol",
        "effort": "high"
      },
      "isRoot": false
    },
    {
      "id": "starter-node-review",
      "label": "審查",
      "writePolicy": "read-only",
      "concurrency": 1,
      "inputRules": [],
      "outputRules": [
        {
          "id": "review-plan",
          "condition": "審查完成時",
          "payload": "結論（通過／需修改）、問題清單與位置、建議改法",
          "target": {
            "kind": "node",
            "nodeId": "starter-node-plan"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 460,
        "y": 120
      },
      "kind": "agent",
      "agentId": "starter-agent-review",
      "model": {
        "runtime": "claude",
        "model": "sonnet"
      },
      "isRoot": false
    }
  ],
  "edges": [
    {
      "source": "starter-node-plan",
      "target": "starter-node-implement"
    },
    {
      "source": "starter-node-implement",
      "target": "starter-node-review"
    },
    {
      "source": "starter-node-review",
      "target": "starter-node-plan"
    }
  ],
  "updatedAt": "2026-11-06T00:00:00.000Z"
};

export const starterFixture = {
  agents: agents.map(agent => AgentDefinition.parse({ ...agent, schemaVersion: CONTRACTS_VERSION })),
  workflow: WorkflowTemplate.parse({ ...workflow, schemaVersion: CONTRACTS_VERSION }),
};
