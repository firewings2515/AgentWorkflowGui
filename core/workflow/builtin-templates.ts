// The built-in templates of the template library (T070): eight templates from the 11-07 SDLC trial (B to I), written for
// any project. Each has its own Agents under the fixed IDs of contracts/starter.ts; the user adds one with
// `workflow.addStarter` and `template`. Nothing here names the trial's project: the test command is the project's own,
// looked up in its files, and every node that runs commands reports what it ran and saw.
import {
  AgentDefinition,
  BUILTIN_AGENT_IDS,
  BUILTIN_WORKFLOW_IDS,
  CONTRACTS_VERSION,
  type BuiltinTemplateKey,
  type ModelOption,
  NodeId,
  type Runtime,
  type Timestamp,
  WorkflowTemplate,
  type WritePolicy,
} from '../../contracts';
import { installStarter, type StarterInstall, starterModel, starterSet } from './starter';

export type BuiltinKey = Exclude<BuiltinTemplateKey, 'starter'>;

// ---- the shared sentences --------------------------------------------------------------------------------------------

/** Where to look for the project's test command. */
const FIND_TESTS = '依序看專案的說明與設定檔（README、CONTRIBUTING 等）、package.json 的 scripts 或同類檔案（Makefile、pyproject.toml 等）';
const RUN_TESTS = `執行交接給的測試指令；交接沒給就${FIND_TESTS}自己找，找不到就在交接裡說明沒有可跑的測試，不要自己編指令。`;
const EVIDENCE = '回報時附上實際執行的指令和輸出重點（例如通過與失敗的數量、失敗訊息），不能只寫「通過」。';
const SCOPE = '只改這次範圍內的東西；發現範圍外的問題列在交接裡，不要順手修。';
const NO_BYPASS = '指令被環境或權限擋下時，照實回報錯誤訊息，不要自己加旗標或改設定繞過。';
/**
 * For a writing node whose next node runs the tests itself (T071): when its own sandbox will not run them (on Windows
 * Codex's writing sandbox cannot start child processes), it hands over with the error instead of waiting on the user.
 */
const BLOCKED_HANDOFF = '測試指令被環境擋下（例如沙箱不允許開子行程）時，不要停下來問使用者：把指令和錯誤訊息照實寫進交接，照常交給下一個節點，由它執行測試。';

// ---- the shape of a template -----------------------------------------------------------------------------------------

interface AgentSpec {
  name: string;
  description: string;
  lines: readonly string[];
}

type Target = { node: string } | 'root' | 'tasks';
interface RuleSpec {
  id: string;
  condition: string;
  payload: string;
  target: Target;
  confirm?: boolean;
}
interface InputSpec {
  id: string;
  condition: string;
  wait?: boolean;
}
interface NodeSpec {
  role: string;
  label: string;
  /** The Agent's role; absent for the merge node. */
  agent?: string;
  runtime?: Runtime;
  writePolicy: WritePolicy;
  concurrency?: number;
  root?: boolean;
  inputs?: readonly InputSpec[];
  outputs: readonly RuleSpec[];
  position: { x: number; y: number };
}
interface TemplateSpec {
  name: string;
  description: string;
  reworkLimit: number;
  isolation: 'same-folder' | 'worktree';
  agents: Record<string, AgentSpec>;
  nodes: readonly NodeSpec[];
  edges: readonly (readonly [string, string])[];
}

const to = (node: string): Target => ({ node });

// ---- the eight templates ---------------------------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: Readonly<Record<BuiltinKey, TemplateSpec>> = {
  // B. Evaluator-optimizer / writer-reviewer (Anthropic; Claude Code best practices).
  'evaluator-optimizer': {
    name: '評估者－優化者',
    description: '需求明確、要反覆修到合格的修改。協調 → 修改者 ⇄ 評審（自己跑測試）→ 協調。不需要 git repo。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '評估優化・協調',
        description: '整理需求、總結結果',
        lines: [
          '你是協調者，直接面對使用者。先弄清楚要的結果、範圍和完成條件，不清楚就先問。',
          `找出專案的測試指令：${FIND_TESTS}。找不到就問使用者，或說明這個專案沒有可跑的測試。`,
          '把需求整理成清楚的修改說明交給「修改者」：要改什麼、範圍、完成條件、測試指令。',
          '收到「評審」的通過報告後，向使用者總結：改了什麼、評審檢查了什麼、測試的證據。',
          '你不修改任何檔案。',
        ],
      },
      writer: {
        name: '評估優化・修改者',
        description: '照說明修改，處理評審意見',
        lines: [
          `你是修改者。照收到的說明修改程式和測試。${SCOPE}`,
          `改完${RUN_TESTS}`,
          `交給評審時說明改了哪些檔案、怎麼改。${EVIDENCE}`,
          '收到評審退回時逐條處理，說明每一條怎麼改，再交回評審。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      judge: {
        name: '評估優化・評審',
        description: '自己跑測試，嚴格把關',
        lines: [
          '你是嚴格的評審。不修改任何檔案，但可以執行指令。',
          '對照修改說明檢查：改動是否符合需求、有沒有超出範圍、測試是否涵蓋邊界情況。',
          `自己執行測試指令，不要只採信修改者的結果。${EVIDENCE}`,
          '有不符就退回修改者，列出具體問題和位置；全部符合才回報協調者通過。不要硬找問題。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 120 },
        outputs: [{ id: 'lead-writer', condition: '需求清楚、可以交給修改者時', payload: '要修改什麼、範圍、完成條件、測試指令', target: to('writer') }] },
      { role: 'writer', label: '修改者', agent: 'writer', runtime: 'codex', writePolicy: 'write', position: { x: 240, y: 120 },
        inputs: [{ id: 'in', condition: '協調者的修改說明或評審的退回意見' }],
        outputs: [{ id: 'writer-judge', condition: '修改完成時（測試跑過，或被環境擋下並附上錯誤）', payload: '改了哪些檔案、做法、執行的指令與輸出重點', target: to('judge') }] },
      { role: 'judge', label: '評審', agent: 'judge', runtime: 'claude', writePolicy: 'exec-only', position: { x: 480, y: 120 },
        inputs: [{ id: 'in', condition: '修改者交來的修改' }],
        outputs: [
          { id: 'judge-rework', condition: '修改不符合需求、超出範圍或測試不足時', payload: '具體問題與位置、你執行的指令與輸出重點', target: to('writer') },
          { id: 'judge-pass', condition: '修改符合需求、測試足夠時', payload: '通過的理由、檢查過的項目、你執行的指令與輸出重點', target: 'root' },
        ] },
    ],
    edges: [['lead', 'writer'], ['writer', 'judge'], ['judge', 'writer']],
  },

  // C. Test-driven development (Claude Code best practices: tests first, confirm they fail, implement, verify).
  tdd: {
    name: '測試驅動（TDD）',
    description: '先寫測試再實作的新功能或修 bug。協調 → 測試撰寫 → 實作 ⇄ 驗證（只執行指令）→ 協調。建議用 git repo，驗證才查得出測試有沒有被改。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: 'TDD・協調',
        description: '把需求整理成可測試的規格',
        lines: [
          '你是協調者，直接面對使用者。先弄清楚要的功能、輸入輸出和錯誤情況，不清楚就先問。',
          `找出專案的測試指令：${FIND_TESTS}。TDD 需要能跑的測試，找不到就先問使用者要怎麼跑。`,
          '把需求整理成可測試的規格交給「測試撰寫」：輸入、輸出、錯誤情況、測試指令。',
          '收到「驗證」的通過報告後，向使用者總結：新增的測試、實作的改動、驗證的證據。',
          '你不修改任何檔案。',
        ],
      },
      tester: {
        name: 'TDD・測試撰寫',
        description: '先寫會失敗的測試',
        lines: [
          '你是測試撰寫者。只寫測試，不寫產品程式碼；照專案既有的測試寫法和位置。',
          '依規格新增測試，執行測試指令，確認新測試因為功能還沒實作而失敗。',
          '交給實作時附上：測試檔清單、預期行為、失敗的輸出重點，以及每個測試檔的 `git hash-object` 值（不是 git 專案就說明無法提供）。',
          NO_BYPASS,
        ],
      },
      builder: {
        name: 'TDD・實作',
        description: '讓測試通過，不改測試',
        lines: [
          `你是實作者。修改產品程式碼讓測試通過；不可以修改測試撰寫寫的測試。${SCOPE}`,
          '完成後執行測試指令，交給驗證：改了哪些檔案、實際執行的指令和輸出重點，並原樣附上測試撰寫給的測試檔清單和雜湊值。',
          '收到驗證退回時修正，再交回驗證。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      verifier: {
        name: 'TDD・驗證',
        description: '跑測試，確認測試沒被改',
        lines: [
          '你是驗證者。不修改任何檔案，只執行指令。',
          `執行測試指令。${EVIDENCE}`,
          '確認測試沒被實作改動：重新計算交接列出的測試檔的 `git hash-object`，和附上的值比對；也可以用 `git status`、`git diff` 看改了哪些檔案。不是 git 專案或沒有雜湊值時，說明沒辦法查。',
          '測試全過、而且測試沒被改動，才回報協調者通過；否則退回實作，附上失敗輸出或被改動的檔案。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 120 },
        outputs: [{ id: 'lead-tester', condition: '規格整理好時', payload: '可測試的規格：輸入、輸出、錯誤情況、測試指令', target: to('tester') }] },
      { role: 'tester', label: '測試撰寫', agent: 'tester', runtime: 'claude', writePolicy: 'write', position: { x: 220, y: 120 },
        inputs: [{ id: 'in', condition: '協調者的規格' }],
        outputs: [{ id: 'tester-builder', condition: '測試寫好且確認會失敗時', payload: '測試檔清單與各檔的雜湊值、預期行為、目前失敗的輸出重點', target: to('builder') }] },
      { role: 'builder', label: '實作', agent: 'builder', runtime: 'codex', writePolicy: 'write', position: { x: 440, y: 120 },
        inputs: [{ id: 'in', condition: '測試撰寫者的測試或驗證的退回' }],
        outputs: [{ id: 'builder-verifier', condition: '實作完成時（測試跑過，或被環境擋下並附上錯誤）', payload: '改了哪些檔案、執行的指令與輸出重點、測試檔清單與雜湊值', target: to('verifier') }] },
      { role: 'verifier', label: '驗證', agent: 'verifier', runtime: 'claude', writePolicy: 'exec-only', position: { x: 660, y: 120 },
        inputs: [{ id: 'in', condition: '實作者交來的實作' }],
        outputs: [
          { id: 'verifier-rework', condition: '測試失敗或測試被改動時', payload: '失敗輸出或被改動的測試檔、你執行的指令', target: to('builder') },
          { id: 'verifier-pass', condition: '測試全過且測試未被改動時', payload: '執行的指令與輸出重點、測試未被改動的檢查結果', target: 'root' },
        ] },
    ],
    edges: [['lead', 'tester'], ['tester', 'builder'], ['builder', 'verifier'], ['verifier', 'builder']],
  },

  // D. Spec-driven development (GitHub Spec Kit, Kiro) with orchestrator-workers: tasks confirmed by the user, parallel
  //    work in task worktrees, review, and the merge node that tests before the target branch moves.
  'spec-parallel': {
    name: '規格驅動＋平行實作',
    description: '要拆成多個 task 的較大功能。規格（task 清單先給你確認）→ 實作（最多 2 個同時）⇄ 審查 → 合併 → 規格。需要 git repo，專案設定要有測試指令。審查會擋下測試產物這類不該進來的檔案。',
    reworkLimit: 2,
    isolation: 'worktree',
    agents: {
      lead: {
        name: '規格驅動・規格',
        description: '寫規格、拆 task、彙整結果',
        lines: [
          '你是規格負責人，直接面對使用者。先弄清楚需求和限制，不清楚就先問。',
          `寫規格：需求（驗收條件用「當…時，系統應…」的句型）、設計（要動的模組和介面）、task 拆解與依賴。找出專案的測試指令（${FIND_TESTS}）寫進規格。`,
          '用 create_tasks 建立 task，有依賴的要標出；task 清單會先給使用者確認。',
          '其他節點讀不到你的工作資料夾，所以交給實作時，要把這個 task 需要的規格完整寫在交接內容裡：驗收條件、介面、測試指令。',
          '收到合併完成的通知後，等全部 task 都合併，再向使用者總結。',
          '你不修改專案的程式碼。',
          NO_BYPASS,
        ],
      },
      builder: {
        name: '規格驅動・實作',
        description: '在 task 的 worktree 照規格實作',
        lines: [
          '你是實作者，在這個 task 自己的 worktree 工作。照交接的規格修改程式和測試，只做這個 task 的範圍；發現範圍外的問題列在交接裡，不要順手修。',
          `完成後${RUN_TESTS}審查只看得到你的交接，所以交給審查時，先原樣附上交接給你的這個 task 的規格（驗收條件、介面、測試指令），再寫改了哪些檔案、實際執行的指令和輸出重點。`,
          '收到審查退回時修正再交回，一樣附上規格；審查指出不該進來的檔案（測試產物、暫存檔）時，刪掉或加進 ignore。不要自己 commit，系統會代為 commit。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      reviewer: {
        name: '規格驅動・審查',
        description: '對照規格審查，自己跑測試',
        lines: [
          '你是審查者。不修改任何檔案，但可以執行指令。',
          `對照實作交接裡附上的 task 規格和驗收條件，檢查實作與測試；交接沒有附上規格時，退回實作要它補上。自己執行測試指令。${EVIDENCE}`,
          // r1 P2-3: what a writing node or this one leaves in the worktree is committed by the GUI at the handoff and merged.
          '跑完測試後，用 `git status` 看 worktree 有沒有新的、沒被 ignore 的檔案（例如測試產生的報告、暫存檔）；再用 `git log --stat` 或 `git show --stat` 看這個 task 已經 commit 的檔案。只看這個 task 的 commit：從交接內容知道 task 改了哪些檔案，或自己找出 task 的起點，不要假設 branch 名稱。',
          '有不該進來的檔案時不能交給合併：退回實作，請它刪掉或加進 ignore。',
          '符合規格、也沒有不該進來的檔案，才交給合併；不符合就退回實作，列出具體問題和位置。不要硬找問題。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '規格', agent: 'lead', runtime: 'claude', writePolicy: 'write', root: true, position: { x: 0, y: 120 },
        outputs: [
          // O-07: the task list of a built-in template waits for the user's confirmation.
          { id: 'lead-tasks', condition: '規格寫好、task 拆解完成時', payload: '每個 task 的標題、範圍、驗收條件和依賴', target: 'tasks', confirm: true },
          { id: 'lead-builder', condition: 'task 已確認、可以開始實作時', payload: '這個 task 的完整規格：驗收條件、介面、測試指令', target: to('builder') },
        ] },
      { role: 'builder', label: '實作', agent: 'builder', runtime: 'codex', writePolicy: 'write', concurrency: 2, position: { x: 240, y: 120 },
        inputs: [{ id: 'in', condition: '規格負責人交來的 task 或審查的退回' }],
        outputs: [{ id: 'builder-reviewer', condition: '實作完成時（測試跑過，或被環境擋下並附上錯誤）', payload: '原樣轉交的 task 規格（驗收條件、介面、測試指令）、改了哪些檔案、執行的指令與輸出重點', target: to('reviewer') }] },
      { role: 'reviewer', label: '審查', agent: 'reviewer', runtime: 'claude', writePolicy: 'exec-only', position: { x: 480, y: 120 },
        inputs: [{ id: 'in', condition: '實作交來的 task：原樣轉交的規格與實作結果' }],
        outputs: [
          { id: 'reviewer-rework', condition: '不符合規格，或有不該進來的檔案時', payload: '具體問題與位置（包括不該進來的檔案）、你執行的指令與輸出重點', target: to('builder') },
          { id: 'reviewer-merge', condition: '符合規格、也沒有不該進來的檔案時', payload: '審查結論、你執行的指令與輸出重點', target: to('merge') },
        ] },
      { role: 'merge', label: '合併', writePolicy: 'write', position: { x: 720, y: 120 },
        outputs: [{ id: 'merged', condition: '合併且測試通過後', payload: '合併結果', target: 'root' }] },
    ],
    edges: [['lead', 'builder'], ['builder', 'reviewer'], ['reviewer', 'builder'], ['reviewer', 'merge']],
  },

  // E. Parallelization by sections (Anthropic), joined by a node that waits for every upstream sent.
  'parallel-review': {
    name: '平行審查＋彙整',
    description: '只想先看問題、不改檔。協調 → 正確性審查＋健壯性審查（同時）→ 彙整 → 協調。不需要 git repo。',
    reworkLimit: 1,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '平行審查・協調',
        description: '分派審查、總結報告',
        lines: [
          '你是協調者，直接面對使用者。先弄清楚要審查的範圍和重點，不清楚就先問。',
          '把審查範圍同時交給「正確性審查」和「健壯性審查」兩個節點。',
          '收到彙整報告後，向使用者總結依嚴重度排序的問題清單。',
          '這個流程只審查，不修改任何檔案。',
        ],
      },
      correctness: {
        name: '平行審查・正確性',
        description: '檢查邏輯是否正確',
        lines: [
          '你是正確性審查者，只讀不改。',
          '對照需求、文件和既有測試，檢查審查範圍內的邏輯是否正確，列出錯誤，每項附檔案、行號和理由。',
          '沒有實際執行過的東西，不要寫成已驗證。完成後交給彙整。',
        ],
      },
      robustness: {
        name: '平行審查・健壯性',
        description: '檢查邊界與錯誤處理',
        lines: [
          '你是健壯性審查者，只讀不改。',
          '檢查審查範圍內的輸入驗證、邊界情況、錯誤處理和資源使用，每項附檔案、行號和理由。',
          `沒有實際執行過的東西，不要寫成已驗證。${NO_BYPASS}完成後交給彙整。`,
        ],
      },
      merger: {
        name: '平行審查・彙整',
        description: '合併兩份審查',
        lines: [
          '你是彙整者，只讀不改。',
          '等兩份審查都到齊，合併重複的問題，依嚴重度排序成一份報告；標出兩份都提到、和只有一份提到的問題。',
          '完成後回報協調者。',
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 160 },
        outputs: [
          { id: 'lead-correct', condition: '要開始審查時（與健壯性審查同時送出）', payload: '審查範圍與重點', target: to('correctness') },
          { id: 'lead-robust', condition: '要開始審查時（與正確性審查同時送出）', payload: '審查範圍與重點', target: to('robustness') },
        ] },
      { role: 'correctness', label: '正確性審查', agent: 'correctness', runtime: 'claude', writePolicy: 'read-only', position: { x: 240, y: 60 },
        inputs: [{ id: 'in', condition: '審查範圍' }],
        outputs: [{ id: 'correct-merge', condition: '審查完成時', payload: '問題清單：檔案、行號、理由', target: to('merger') }] },
      { role: 'robustness', label: '健壯性審查', agent: 'robustness', runtime: 'codex', writePolicy: 'read-only', position: { x: 240, y: 260 },
        inputs: [{ id: 'in', condition: '審查範圍' }],
        outputs: [{ id: 'robust-merge', condition: '審查完成時', payload: '問題清單：檔案、行號、理由', target: to('merger') }] },
      { role: 'merger', label: '彙整', agent: 'merger', runtime: 'claude', writePolicy: 'read-only', position: { x: 480, y: 160 },
        inputs: [{ id: 'both', condition: '兩份審查報告', wait: true }],
        outputs: [{ id: 'merger-root', condition: '彙整完成時', payload: '依嚴重度排序的問題報告', target: 'root' }] },
    ],
    edges: [['lead', 'correctness'], ['lead', 'robustness'], ['correctness', 'merger'], ['robustness', 'merger']],
  },

  // F. Routing (Anthropic): root classifies the request and sends it down one path only.
  routing: {
    name: '路由分流',
    description: 'bug 和新功能混在一起的需求。分流 → 修 bug 或 新功能（只走一條）→ 審查 → 分流。不需要 git repo。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '路由・分流',
        description: '判斷 bug 或新功能',
        lines: [
          '你是分流者，直接面對使用者。判斷需求是「bug 修正」還是「新功能」，只交給對應的一個節點：bug 交給「修 bug」，新功能交給「新功能」。判斷不了就先問使用者。',
          `找出專案的測試指令（${FIND_TESTS}）寫進交接；找不到就說明。`,
          '收到審查通過後向使用者總結，並說明你分到哪一條路徑。',
          '你不修改任何檔案。',
        ],
      },
      fixer: {
        name: '路由・修 bug',
        description: '重現後做最小修正',
        lines: [
          '你是 bug 修正者。先寫一個能重現 bug 的測試並確認它失敗，再做最小的修正。只修這個 bug；發現其他問題列在交接裡，不要順手修。',
          '執行測試指令確認通過，交給審查：重現測試、修正內容、實際執行的指令和輸出重點。',
          '收到審查退回時修正再交回。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      feature: {
        name: '路由・新功能',
        description: '照需求新增功能和測試',
        lines: [
          '你是新功能開發者。照需求新增功能和測試，只做這個需求的範圍；發現其他問題列在交接裡，不要順手修。',
          '執行測試指令確認通過，交給審查：新增內容、實際執行的指令和輸出重點。',
          '收到審查退回時修正再交回。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      reviewer: {
        name: '路由・審查',
        description: '檢查修改，自己跑測試',
        lines: [
          '你是審查者。不修改任何檔案，但可以執行指令。',
          `檢查修改有沒有解決問題、有沒有多餘或超出範圍的改動；自己執行測試指令。${EVIDENCE}`,
          '通過就回報分流者；不通過就退回原本的修改節點，列出具體問題。不要硬找問題。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '分流', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 160 },
        outputs: [
          { id: 'route-bug', condition: '需求是 bug 修正時', payload: 'bug 描述、重現方式、測試指令', target: to('fixer') },
          { id: 'route-feature', condition: '需求是新功能時', payload: '功能需求、完成條件、測試指令', target: to('feature') },
        ] },
      { role: 'fixer', label: '修 bug', agent: 'fixer', runtime: 'codex', writePolicy: 'write', position: { x: 240, y: 60 },
        inputs: [{ id: 'in', condition: 'bug 回報或審查退回' }],
        outputs: [{ id: 'fixer-review', condition: '修正完成時', payload: '重現測試、修正內容、執行的指令與輸出重點', target: to('reviewer') }] },
      { role: 'feature', label: '新功能', agent: 'feature', runtime: 'claude', writePolicy: 'write', position: { x: 240, y: 260 },
        inputs: [{ id: 'in', condition: '功能需求或審查退回' }],
        outputs: [{ id: 'feature-review', condition: '功能完成時', payload: '新增內容與測試、執行的指令與輸出重點', target: to('reviewer') }] },
      { role: 'reviewer', label: '審查', agent: 'reviewer', runtime: 'claude', writePolicy: 'exec-only', position: { x: 480, y: 160 },
        inputs: [{ id: 'in', condition: '修 bug 或新功能交來的修改' }],
        outputs: [
          { id: 'review-fixer', condition: 'bug 修正不正確時', payload: '具體問題、你執行的指令與輸出重點', target: to('fixer') },
          { id: 'review-feature', condition: '新功能不正確時', payload: '具體問題、你執行的指令與輸出重點', target: to('feature') },
          { id: 'review-pass', condition: '修改正確時', payload: '結論、你執行的指令與輸出重點', target: 'root' },
        ] },
    ],
    edges: [['lead', 'fixer'], ['lead', 'feature'], ['fixer', 'reviewer'], ['feature', 'reviewer'], ['reviewer', 'fixer'], ['reviewer', 'feature']],
  },

  // G. Documentation: prompt chaining with a gate, a technical review against the code.
  'docs-review': {
    name: '文件撰寫＋技術審稿',
    description: '照程式實際行為寫文件。協調 → 撰寫 ⇄ 審稿 → 協調。不需要 git repo。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '文件・協調',
        description: '確認文件需求、總結',
        lines: [
          '你是協調者，直接面對使用者。弄清楚要寫什麼文件、給誰看、放在哪裡，不清楚就先問。',
          '把文件需求交給「撰寫」。',
          '收到「審稿」通過後向使用者總結，並列出審稿發現的程式與既有文件不一致的地方。',
          '你不修改任何檔案。',
        ],
      },
      writer: {
        name: '文件・撰寫',
        description: '照程式實際行為寫文件',
        lines: [
          '你是技術文件撰寫者。讀相關的程式碼，照程式實際的行為寫文件，不寫程式沒有的功能。不修改程式碼。',
          '程式和既有文件不一致時，在文件或交接裡標出來，不要擅自改程式。',
          '完成後交給審稿，附上文件路徑和摘要；收到退回時逐條修正再交回。',
          NO_BYPASS,
        ],
      },
      checker: {
        name: '文件・審稿',
        description: '對照程式逐條審稿',
        lines: [
          '你是技術審稿者，只讀不改。',
          '逐一對照程式碼檢查文件：名稱、參數、回傳值、錯誤訊息、行為規則是否和程式一致；程式和既有文件不一致的地方要指出。',
          '有錯就退回撰寫，列出位置和正確內容；全部正確才回報協調者。不要硬找問題。',
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 120 },
        outputs: [{ id: 'lead-writer', condition: '文件需求清楚時', payload: '要寫的文件、讀者、存放位置', target: to('writer') }] },
      { role: 'writer', label: '撰寫', agent: 'writer', runtime: 'claude', writePolicy: 'write', position: { x: 240, y: 120 },
        inputs: [{ id: 'in', condition: '文件需求或審稿退回' }],
        outputs: [{ id: 'writer-checker', condition: '文件寫好時', payload: '文件路徑與摘要、發現的程式與既有文件不一致', target: to('checker') }] },
      { role: 'checker', label: '審稿', agent: 'checker', runtime: 'codex', writePolicy: 'read-only', position: { x: 480, y: 120 },
        inputs: [{ id: 'in', condition: '撰寫交來的文件' }],
        outputs: [
          { id: 'checker-rework', condition: '文件與程式不一致時', payload: '錯誤位置與正確內容', target: to('writer') },
          { id: 'checker-pass', condition: '文件正確時', payload: '審稿結論，以及發現的程式與既有文件不一致', target: 'root' },
        ] },
    ],
    edges: [['lead', 'writer'], ['writer', 'checker'], ['checker', 'writer']],
  },

  // H. Safe refactoring: analyse, refactor without changing behaviour, verify with the tests (an exec-only gate).
  'safe-refactor': {
    name: '安全重構',
    description: '行為不變的整理。協調 → 分析 → 重構 ⇄ 驗證（只執行指令）→ 協調。建議用 git repo，驗證才查得出介面和測試有沒有被改。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '重構・協調',
        description: '確認重構目標與限制',
        lines: [
          '你是協調者，直接面對使用者。弄清楚重構的目標、範圍和限制，不清楚就先問。',
          `找出專案的測試指令（${FIND_TESTS}）寫進交接；找不到就問使用者。沒有測試時，要求重構前先補保護行為的測試。`,
          '把重構目標交給「分析」；收到「驗證」通過後向使用者總結：改了什麼、行為不變的證據、發現但沒修的問題。',
          '你不修改任何檔案。',
        ],
      },
      analyst: {
        name: '重構・分析',
        description: '找出問題、寫重構步驟',
        lines: [
          '你是程式分析者，只讀不改。',
          '找出重構目標相關的問題（可讀性、重複、難懂的寫法），寫出具體的重構步驟，以及要保護的對外行為（對外的函式、介面、輸出）。',
          '列出發現但不在這次範圍的 bug，不要要求修。完成後交給重構者。',
        ],
      },
      refactorer: {
        name: '重構・重構者',
        description: '行為不變的重構',
        lines: [
          '你是重構者。照分析的步驟重構，對外行為必須完全不變；不修 bug，不改範圍外的東西。',
          '可以先補保護行為的測試再重構。完成後執行測試指令，交給驗證：改動摘要、實際執行的指令和輸出重點。',
          '收到驗證退回時修正再交回。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      verifier: {
        name: '重構・驗證',
        description: '確認行為不變',
        lines: [
          '你是驗證者。不修改任何檔案，只執行指令。',
          `執行測試指令；用 \`git diff\` 檢查對外的介面沒變、既有測試沒有被刪改（不是 git 專案時說明沒辦法查）。${EVIDENCE}`,
          '行為不變、測試通過，才回報協調者；否則退回重構者並附上證據。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 120 },
        outputs: [{ id: 'lead-analyst', condition: '重構目標清楚時', payload: '重構目標、範圍、限制、測試指令', target: to('analyst') }] },
      { role: 'analyst', label: '分析', agent: 'analyst', runtime: 'claude', writePolicy: 'read-only', position: { x: 220, y: 120 },
        inputs: [{ id: 'in', condition: '重構目標' }],
        outputs: [{ id: 'analyst-refactorer', condition: '分析完成時', payload: '重構步驟、要保護的對外行為、不在範圍的 bug、測試指令', target: to('refactorer') }] },
      { role: 'refactorer', label: '重構', agent: 'refactorer', runtime: 'codex', writePolicy: 'write', position: { x: 440, y: 120 },
        inputs: [{ id: 'in', condition: '重構步驟或驗證退回' }],
        outputs: [{ id: 'refactorer-verifier', condition: '重構完成時（測試跑過，或被環境擋下並附上錯誤）', payload: '改動摘要、執行的指令與輸出重點', target: to('verifier') }] },
      { role: 'verifier', label: '驗證', agent: 'verifier', runtime: 'claude', writePolicy: 'exec-only', position: { x: 660, y: 120 },
        inputs: [{ id: 'in', condition: '重構結果' }],
        outputs: [
          { id: 'verifier-rework', condition: '行為改變或測試失敗時', payload: '證據：執行的指令、輸出、有問題的改動', target: to('refactorer') },
          { id: 'verifier-pass', condition: '行為不變、測試通過時', payload: '驗證摘要、執行的指令與輸出重點', target: 'root' },
        ] },
    ],
    edges: [['lead', 'analyst'], ['analyst', 'refactorer'], ['refactorer', 'verifier'], ['verifier', 'refactorer']],
  },

  // I. Cross-model review (two reviewers in parallel, writer/reviewer and voting), then fix after the join and verify.
  'cross-review': {
    name: '雙模型交叉審查＋修正',
    description: 'Claude 和 Codex 各審一次，只修確認過的問題。協調 → 兩個審查（同時）→ 彙整修正 ⇄ 驗證（只執行指令）→ 協調。不需要 git repo。',
    reworkLimit: 2,
    isolation: 'same-folder',
    agents: {
      lead: {
        name: '交叉審查・協調',
        description: '分派兩個審查、總結修正',
        lines: [
          '你是協調者，直接面對使用者。弄清楚審查的範圍和重點，不清楚就先問。',
          `找出專案的測試指令（${FIND_TESTS}）寫進交接；找不到就說明。`,
          '把審查範圍同時交給 Claude 審查和 Codex 審查。',
          '收到驗證通過後向使用者總結：修了什麼、不修什麼與理由、驗證的證據。',
          '你不修改任何檔案。',
        ],
      },
      reviewer: {
        name: '交叉審查・審查者',
        description: '兩個審查節點共用',
        lines: [
          '你是審查者，只讀不改。',
          '找出審查範圍內的錯誤（對照需求、文件與邊界情況），每個問題附檔案、行號和重現方式。',
          '沒有實際執行過的東西，不要寫成已驗證。完成後交給彙整修正。',
        ],
      },
      fixer: {
        name: '交叉審查・修正者',
        description: '只修確認過的問題',
        lines: [
          '你是修正者。等兩份審查都到齊，只修兩份都提到、或你確認能重現的問題；每個修正都補測試，不改範圍外的東西。',
          '列出你決定不修的問題和理由。',
          '完成後執行測試指令，交給驗證：修了什麼、不修什麼與理由、實際執行的指令和輸出重點。收到驗證退回時修正再交回。',
          NO_BYPASS,
          BLOCKED_HANDOFF,
        ],
      },
      verifier: {
        name: '交叉審查・驗證',
        description: '跑測試，確認每個修正都有測試',
        lines: [
          '你是驗證者。不修改任何檔案，只執行指令。',
          `執行測試指令，檢查每個修正都有對應的測試。${EVIDENCE}`,
          '通過就回報協調者；否則退回修正者並附上證據。',
          NO_BYPASS,
        ],
      },
    },
    nodes: [
      { role: 'lead', label: '協調', agent: 'lead', runtime: 'claude', writePolicy: 'read-only', root: true, position: { x: 0, y: 160 },
        outputs: [
          { id: 'lead-revA', condition: '開始審查時（與 Codex 審查同時送出）', payload: '審查範圍、重點、測試指令', target: to('review-claude') },
          { id: 'lead-revB', condition: '開始審查時（與 Claude 審查同時送出）', payload: '審查範圍、重點、測試指令', target: to('review-codex') },
        ] },
      { role: 'review-claude', label: 'Claude 審查', agent: 'reviewer', runtime: 'claude', writePolicy: 'read-only', position: { x: 220, y: 60 },
        inputs: [{ id: 'in', condition: '審查範圍' }],
        outputs: [{ id: 'revA-fixer', condition: '審查完成時', payload: '問題清單：檔案、行號、重現方式', target: to('fixer') }] },
      { role: 'review-codex', label: 'Codex 審查', agent: 'reviewer', runtime: 'codex', writePolicy: 'read-only', position: { x: 220, y: 260 },
        inputs: [{ id: 'in', condition: '審查範圍' }],
        outputs: [{ id: 'revB-fixer', condition: '審查完成時', payload: '問題清單：檔案、行號、重現方式', target: to('fixer') }] },
      { role: 'fixer', label: '彙整修正', agent: 'fixer', runtime: 'codex', writePolicy: 'write', position: { x: 440, y: 160 },
        inputs: [{ id: 'both', condition: '兩份審查報告（或驗證退回）', wait: true }],
        outputs: [{ id: 'fixer-verifier', condition: '修正完成時（測試跑過，或被環境擋下並附上錯誤）', payload: '修了什麼、不修什麼與理由、執行的指令與輸出重點', target: to('verifier') }] },
      { role: 'verifier', label: '驗證', agent: 'verifier', runtime: 'claude', writePolicy: 'exec-only', position: { x: 660, y: 160 },
        inputs: [{ id: 'in', condition: '修正結果' }],
        outputs: [
          { id: 'verifier-rework', condition: '測試失敗或修正缺測試時', payload: '證據：執行的指令與輸出', target: to('fixer') },
          { id: 'verifier-pass', condition: '測試通過且每個修正都有測試時', payload: '驗證摘要、執行的指令與輸出重點', target: 'root' },
        ] },
    ],
    edges: [['lead', 'review-claude'], ['lead', 'review-codex'], ['review-claude', 'fixer'], ['review-codex', 'fixer'], ['fixer', 'verifier'], ['verifier', 'fixer']],
  },
};

export const BUILTIN_KEYS = Object.keys(BUILTIN_TEMPLATES) as BuiltinKey[];

/** The node ID of a role in a built-in template; unique within its template. */
export const builtinNodeId = (key: BuiltinKey, role: string): NodeId => NodeId.parse(`builtin-${key}-${role}`);

const agentIdOf = (key: BuiltinKey, role: string) => {
  const ids = BUILTIN_AGENT_IDS[key] as Readonly<Record<string, AgentDefinition['id']>>;
  const id = ids[role];
  if (id === undefined) throw new Error(`no fixed Agent ID for ${key}/${role}`);
  return id;
};

/**
 * A template of the template library with its Agents, made with the models listed now and parsed with the contracts'
 * schemas: the starter set for `starter`, else the built-in template and its own Agents.
 */
export const builtinSet = (
  key: BuiltinTemplateKey,
  models: readonly ModelOption[],
  now: Timestamp,
): { agents: AgentDefinition[]; workflow: WorkflowTemplate } => {
  if (key === 'starter') return starterSet(models, now);
  const spec = BUILTIN_TEMPLATES[key];
  const agents = Object.entries(spec.agents).map(([role, a]) =>
    AgentDefinition.parse({ schemaVersion: CONTRACTS_VERSION, id: agentIdOf(key, role), revision: 0, name: a.name, description: a.description, instructions: a.lines.join('\n'), updatedAt: now }),
  );
  const target = (t: Target) => (t === 'root' ? { kind: 'root' } : t === 'tasks' ? { kind: 'tasks' } : { kind: 'node', nodeId: builtinNodeId(key, t.node) });
  const nodes = spec.nodes.map((n) => {
    const base = {
      id: builtinNodeId(key, n.role),
      label: n.label,
      writePolicy: n.writePolicy,
      concurrency: n.concurrency ?? 1,
      inputRules: (n.inputs ?? []).map((r) => ({ id: r.id, condition: r.condition, waitForAllUpstream: r.wait ?? false })),
      outputRules: n.outputs.map((r) => ({ id: r.id, condition: r.condition, payload: r.payload, target: target(r.target), requiresUserConfirmation: r.confirm ?? false })),
      position: n.position,
    };
    if (n.agent === undefined) return { ...base, kind: 'merge' };
    return { ...base, kind: 'agent', agentId: agentIdOf(key, n.agent), model: starterModel(n.runtime ?? 'claude', models), isRoot: n.root ?? false };
  });
  const workflow = WorkflowTemplate.parse({
    schemaVersion: CONTRACTS_VERSION,
    id: BUILTIN_WORKFLOW_IDS[key],
    revision: 0,
    name: spec.name,
    description: spec.description,
    reworkLimit: spec.reworkLimit,
    isolation: spec.isolation,
    nodes,
    edges: spec.edges.map(([source, targetRole]) => ({ source: builtinNodeId(key, source), target: builtinNodeId(key, targetRole) })),
    updatedAt: now,
  });
  return { agents, workflow };
};

type LibraryRepositories = Parameters<typeof installStarter>[0];

/** What `installBuiltin` wrote, by kind (r1 P2-1): an ID stored now is either one of the set's Agents or its template. */
export interface LibraryInstall extends StarterInstall {
  /** The set's Agents stored now (not the ones already there). */
  addedAgents: AgentDefinition['id'][];
  /** Whether the template was stored now. */
  workflowAdded: boolean;
}

/**
 * `workflow.addStarter` (T063, T070): adds what of one library template is missing, in one transaction
 * (`seedDefinitions`). `starter` is the starter set as before (and sets its mark); another key writes only that template
 * and its own Agents, keeps whatever is already stored under their IDs (an edited Agent or template is not overwritten)
 * and leaves the marks alone. A first start never comes here (`installStarter` with `first-start`).
 */
export const installBuiltin = async (
  repos: LibraryRepositories,
  options: { key: BuiltinTemplateKey; models: readonly ModelOption[]; now: Timestamp },
): Promise<LibraryInstall> => {
  const { key, models, now } = options;
  const set = builtinSet(key, models, now);
  let installed: StarterInstall;
  if (key === 'starter') installed = await installStarter(repos, { models, now, mode: 'user' });
  else {
    const added = await repos.seedDefinitions({ agents: set.agents, workflows: [set.workflow] });
    const workflow = await repos.workflows.get(set.workflow.id);
    installed = { added, ...(workflow !== undefined && { workflow }) };
  }
  // The IDs stored now come back mixed; they are told apart by the set's own IDs, which never collide with one another, so
  // a record of the other kind under the same ID (an Agent named like the template) is never taken for one written now.
  const added = new Set(installed.added);
  return { ...installed, addedAgents: set.agents.filter((a) => added.has(a.id)).map((a) => a.id), workflowAdded: added.has(set.workflow.id) };
};
