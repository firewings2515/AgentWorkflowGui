// T070: the built-in template 「測試驅動（TDD）」 as core/workflow/builtin-templates.ts makes it (no model listed yet, at a
// fixed time), for the renderer's tests, which may not load the core. tests/t070-builtin-templates.test.ts checks that the
// core still makes exactly this.
import { AgentDefinition, CONTRACTS_VERSION, WorkflowTemplate } from '../../../contracts';

export const BUILTIN_FIXTURE_TIME = '2026-11-10T00:00:00.000Z';
const agents = [
  {
    "id": "builtin-agent-tdd-lead",
    "revision": 0,
    "name": "TDD・協調",
    "description": "把需求整理成可測試的規格",
    "instructions": "你是協調者，直接面對使用者。先弄清楚要的功能、輸入輸出和錯誤情況，不清楚就先問。\n找出專案的測試指令：依序看專案的說明與設定檔（README、CONTRIBUTING 等）、package.json 的 scripts 或同類檔案（Makefile、pyproject.toml 等）。TDD 需要能跑的測試，找不到就先問使用者要怎麼跑。\n把需求整理成可測試的規格交給「測試撰寫」：輸入、輸出、錯誤情況、測試指令。\n收到「驗證」的通過報告後，向使用者總結：新增的測試、實作的改動、驗證的證據。\n你不修改任何檔案。",
    "updatedAt": "2026-11-10T00:00:00.000Z"
  },
  {
    "id": "builtin-agent-tdd-tester",
    "revision": 0,
    "name": "TDD・測試撰寫",
    "description": "先寫會失敗的測試",
    "instructions": "你是測試撰寫者。只寫測試，不寫產品程式碼；照專案既有的測試寫法和位置。\n依規格新增測試，執行測試指令，確認新測試因為功能還沒實作而失敗。\n交給實作時附上：測試檔清單、預期行為、失敗的輸出重點，以及每個測試檔的 `git hash-object` 值（不是 git 專案就說明無法提供）。\n指令被環境或權限擋下時，照實回報錯誤訊息，不要自己加旗標或改設定繞過。",
    "updatedAt": "2026-11-10T00:00:00.000Z"
  },
  {
    "id": "builtin-agent-tdd-builder",
    "revision": 0,
    "name": "TDD・實作",
    "description": "讓測試通過，不改測試",
    "instructions": "你是實作者。修改產品程式碼讓測試通過；不可以修改測試撰寫寫的測試。只改這次範圍內的東西；發現範圍外的問題列在交接裡，不要順手修。\n完成後執行測試指令，交給驗證：改了哪些檔案、實際執行的指令和輸出重點，並原樣附上測試撰寫給的測試檔清單和雜湊值。\n收到驗證退回時修正，再交回驗證。\n指令被環境或權限擋下時，照實回報錯誤訊息，不要自己加旗標或改設定繞過。",
    "updatedAt": "2026-11-10T00:00:00.000Z"
  },
  {
    "id": "builtin-agent-tdd-verifier",
    "revision": 0,
    "name": "TDD・驗證",
    "description": "跑測試，確認測試沒被改",
    "instructions": "你是驗證者。不修改任何檔案，只執行指令。\n執行測試指令。回報時附上實際執行的指令和輸出重點（例如通過與失敗的數量、失敗訊息），不能只寫「通過」。\n確認測試沒被實作改動：重新計算交接列出的測試檔的 `git hash-object`，和附上的值比對；也可以用 `git status`、`git diff` 看改了哪些檔案。不是 git 專案或沒有雜湊值時，說明沒辦法查。\n測試全過、而且測試沒被改動，才回報協調者通過；否則退回實作，附上失敗輸出或被改動的檔案。\n指令被環境或權限擋下時，照實回報錯誤訊息，不要自己加旗標或改設定繞過。",
    "updatedAt": "2026-11-10T00:00:00.000Z"
  }
];
const workflow = {
  "id": "builtin-workflow-tdd",
  "revision": 0,
  "name": "測試驅動（TDD）",
  "description": "先寫測試再實作的新功能或修 bug。協調 → 測試撰寫 → 實作 ⇄ 驗證（只執行指令）→ 協調。建議用 git repo，驗證才查得出測試有沒有被改。",
  "reworkLimit": 2,
  "isolation": "same-folder",
  "nodes": [
    {
      "id": "builtin-tdd-lead",
      "label": "協調",
      "writePolicy": "read-only",
      "concurrency": 1,
      "inputRules": [],
      "outputRules": [
        {
          "id": "lead-tester",
          "condition": "規格整理好時",
          "payload": "可測試的規格：輸入、輸出、錯誤情況、測試指令",
          "target": {
            "kind": "node",
            "nodeId": "builtin-tdd-tester"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 0,
        "y": 120
      },
      "kind": "agent",
      "agentId": "builtin-agent-tdd-lead",
      "model": {
        "runtime": "claude",
        "model": "sonnet"
      },
      "isRoot": true
    },
    {
      "id": "builtin-tdd-tester",
      "label": "測試撰寫",
      "writePolicy": "write",
      "concurrency": 1,
      "inputRules": [
        {
          "id": "in",
          "condition": "協調者的規格",
          "waitForAllUpstream": false
        }
      ],
      "outputRules": [
        {
          "id": "tester-builder",
          "condition": "測試寫好且確認會失敗時",
          "payload": "測試檔清單與各檔的雜湊值、預期行為、目前失敗的輸出重點",
          "target": {
            "kind": "node",
            "nodeId": "builtin-tdd-builder"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 220,
        "y": 120
      },
      "kind": "agent",
      "agentId": "builtin-agent-tdd-tester",
      "model": {
        "runtime": "claude",
        "model": "sonnet"
      },
      "isRoot": false
    },
    {
      "id": "builtin-tdd-builder",
      "label": "實作",
      "writePolicy": "write",
      "concurrency": 1,
      "inputRules": [
        {
          "id": "in",
          "condition": "測試撰寫者的測試或驗證的退回",
          "waitForAllUpstream": false
        }
      ],
      "outputRules": [
        {
          "id": "builder-verifier",
          "condition": "實作完成、測試跑過時",
          "payload": "改了哪些檔案、執行的指令與輸出重點、測試檔清單與雜湊值",
          "target": {
            "kind": "node",
            "nodeId": "builtin-tdd-verifier"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 440,
        "y": 120
      },
      "kind": "agent",
      "agentId": "builtin-agent-tdd-builder",
      "model": {
        "runtime": "codex",
        "model": "gpt-6.1-sol",
        "effort": "high"
      },
      "isRoot": false
    },
    {
      "id": "builtin-tdd-verifier",
      "label": "驗證",
      "writePolicy": "exec-only",
      "concurrency": 1,
      "inputRules": [
        {
          "id": "in",
          "condition": "實作者交來的實作",
          "waitForAllUpstream": false
        }
      ],
      "outputRules": [
        {
          "id": "verifier-rework",
          "condition": "測試失敗或測試被改動時",
          "payload": "失敗輸出或被改動的測試檔、你執行的指令",
          "target": {
            "kind": "node",
            "nodeId": "builtin-tdd-builder"
          },
          "requiresUserConfirmation": false
        },
        {
          "id": "verifier-pass",
          "condition": "測試全過且測試未被改動時",
          "payload": "執行的指令與輸出重點、測試未被改動的檢查結果",
          "target": {
            "kind": "root"
          },
          "requiresUserConfirmation": false
        }
      ],
      "position": {
        "x": 660,
        "y": 120
      },
      "kind": "agent",
      "agentId": "builtin-agent-tdd-verifier",
      "model": {
        "runtime": "claude",
        "model": "sonnet"
      },
      "isRoot": false
    }
  ],
  "edges": [
    {
      "source": "builtin-tdd-lead",
      "target": "builtin-tdd-tester"
    },
    {
      "source": "builtin-tdd-tester",
      "target": "builtin-tdd-builder"
    },
    {
      "source": "builtin-tdd-builder",
      "target": "builtin-tdd-verifier"
    },
    {
      "source": "builtin-tdd-verifier",
      "target": "builtin-tdd-builder"
    }
  ],
  "updatedAt": "2026-11-10T00:00:00.000Z"
};

export const tddFixture = {
  agents: agents.map(agent => AgentDefinition.parse({ ...agent, schemaVersion: CONTRACTS_VERSION })),
  workflow: WorkflowTemplate.parse({ ...workflow, schemaVersion: CONTRACTS_VERSION }),
};
