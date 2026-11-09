// T070: what the template library shows of each template (the renderer cannot load the core that makes them). The name
// is the template's own name, and a built-in template's summary its own description (the starter template keeps its
// description of 0.11, so its summary is written here); tests/t070-builtin-templates.test.ts checks that the core
// still makes exactly these, and that `needsGit` is true exactly for the templates with task worktrees.
import { BUILTIN_WORKFLOW_IDS, type BuiltinTemplateKey, type WorkflowId } from '../../../contracts';

export interface LibraryEntry {
  key: BuiltinTemplateKey;
  workflowId: WorkflowId;
  name: string;
  /** What it suits, how its nodes go, whether it needs a git repository. */
  summary: string;
  /** Its runs work in task worktrees: the project folder must be a git repository. */
  needsGit: boolean;
}

const entry = (key: BuiltinTemplateKey, name: string, summary: string, needsGit = false): LibraryEntry => ({ key, workflowId: BUILTIN_WORKFLOW_IDS[key], name, summary, needsGit });

/** The library's templates, the starter template first. */
export const TEMPLATE_LIBRARY: readonly LibraryEntry[] = [
  entry('starter', '規劃 → 實作 → 審查', '一般的修改工作。規劃拆解 task（清單先給你確認）→ 實作 → 審查，審查回報規劃。不需要 git repo。'),
  entry('evaluator-optimizer', '評估者－優化者', '需求明確、要反覆修到合格的修改。協調 → 修改者 ⇄ 評審（自己跑測試）→ 協調。不需要 git repo。'),
  entry('tdd', '測試驅動（TDD）', '先寫測試再實作的新功能或修 bug。協調 → 測試撰寫 → 實作 ⇄ 驗證（只執行指令）→ 協調。建議用 git repo，驗證才查得出測試有沒有被改。'),
  entry('spec-parallel', '規格驅動＋平行實作', '要拆成多個 task 的較大功能。規格（task 清單先給你確認）→ 實作（最多 2 個同時）⇄ 審查 → 合併 → 規格。需要 git repo，專案設定要有測試指令。', true),
  entry('parallel-review', '平行審查＋彙整', '只想先看問題、不改檔。協調 → 正確性審查＋健壯性審查（同時）→ 彙整 → 協調。不需要 git repo。'),
  entry('routing', '路由分流', 'bug 和新功能混在一起的需求。分流 → 修 bug 或 新功能（只走一條）→ 審查 → 分流。不需要 git repo。'),
  entry('docs-review', '文件撰寫＋技術審稿', '照程式實際行為寫文件。協調 → 撰寫 ⇄ 審稿 → 協調。不需要 git repo。'),
  entry('safe-refactor', '安全重構', '行為不變的整理。協調 → 分析 → 重構 ⇄ 驗證（只執行指令）→ 協調。建議用 git repo，驗證才查得出介面和測試有沒有被改。'),
  entry('cross-review', '雙模型交叉審查＋修正', 'Claude 和 Codex 各審一次，只修確認過的問題。協調 → 兩個審查（同時）→ 彙整修正 ⇄ 驗證（只執行指令）→ 協調。不需要 git repo。'),
];
