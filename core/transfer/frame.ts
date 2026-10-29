// The content of a transfer (R-02, SP-09): the fixed frame (goal, handoff note, related diff, current test
// output, source session and tool) and the GUI's digest of the source's history, which calls no model.
// Pure functions: the frame depends on the proposal's fields only, so the payload sent after a restart has
// the hash the user confirmed.
import type { Conversation, HistoryEntry } from '../ports';
import type { Message, Runtime, SessionItem, TransferProposal } from '../../contracts';

/** What a draft holds until its source reaches a turn boundary (contracts require a goal even then). */
export const DRAFT_GOAL = '(being prepared: waiting for the source session to finish its turn)';

/** What the source agent is asked when the user wants its own note (`noteSource: 'agent'`). */
export const NOTE_REQUEST = [
  'The user is moving this work to a new session in another tool.',
  'Write a handoff note for whoever continues it: the goal, what is done, what is not done yet, the evidence',
  '(tests or commands you ran and their results) and the files involved.',
  'Reply with the note only. Do not change any files and do not run anything.',
].join('\n');

const MESSAGE_LIMIT = 600;
const GOAL_LIMIT = 2000;
const NOTE_LINES = 80;
/** Commands whose output counts as the current test output (no setting names the test command yet, T023 G-4). */
const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|ava|phpunit|rspec|ctest)\b/i;

/** Cut with the size of what was left out said, never silently. */
const clip = (text: string, limit: number): string => {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… (${String(trimmed.length - limit)} more characters in the source session)`;
};

export interface Digest {
  goal: string;
  note: string;
  diff: string;
  testOutput: string;
}

type CommandItem = Extract<SessionItem, { kind: 'command' }>;

const ownEntry = (e: HistoryEntry) => (e.kind === 'message' ? e.message.nativeTaskId : e.kind === 'item' ? e.item.nativeTaskId : e.turn.nativeTaskId) === undefined;

const messageLine = (m: Message): string | undefined => {
  if (m.role === 'assistant') return `Agent: ${clip(m.text, MESSAGE_LIMIT)}`;
  if (m.role !== 'user') return undefined;
  switch (m.origin.kind) {
    case 'user':
      return `User: ${clip(m.text, MESSAGE_LIMIT)}`;
    case 'peer':
    case 'handoff':
      return `Message from session ${m.origin.fromSessionId}: ${clip(m.text, MESSAGE_LIMIT)}`;
    default:
      return undefined;
  }
};

const ended = (c: CommandItem) => (c.exitCode !== undefined ? `exit ${String(c.exitCode)}` : c.state);

/**
 * The GUI's digest of a session's history, oldest first (SP-09): the user's messages, the agent's replies,
 * commands with their exit codes and file changes. Only the session's own entries (not its sub-agents').
 * Older lines past the limit are left out with their number said.
 */
export const digestOf = (entries: readonly HistoryEntry[], fallbackGoal: string): Digest => {
  const lines: string[] = [];
  const diffs: string[] = [];
  let goal: string | undefined;
  let test: CommandItem | undefined;
  for (const entry of entries.filter(ownEntry)) {
    if (entry.kind === 'message') {
      const { message } = entry;
      if (message.role === 'user' && message.origin.kind === 'user' && message.text.trim().length > 0) goal ??= message.text;
      const line = messageLine(message);
      if (line !== undefined) lines.push(line);
    } else if (entry.kind === 'item') {
      const { item } = entry;
      if (item.kind === 'command') {
        lines.push(`$ ${item.command} → ${ended(item)}`);
        if (TEST_COMMAND.test(item.command) && item.state !== 'running' && item.state !== 'declined') test = item;
      } else if (item.kind === 'fileChange' && item.state === 'applied') {
        lines.push(`Changed: ${item.changes.map((c) => `${c.path} (${c.change})`).join(', ')}`);
        if (item.diff !== undefined && item.diff.length > 0) diffs.push(item.diff);
      }
    }
  }
  const omitted = lines.length - NOTE_LINES;
  const kept = omitted > 0 ? [`(${String(omitted)} earlier entries are left out; the source session keeps the full conversation.)`, ...lines.slice(-NOTE_LINES)] : lines;
  return {
    goal: clip(goal ?? fallbackGoal, GOAL_LIMIT),
    note: kept.join('\n'),
    diff: diffs.join('\n'),
    testOutput:
      test === undefined ? '' : [`$ ${test.command}`, `(${ended(test)})`, test.output, ...(test.outputTruncated ? ['(the runtime kept only the tail of this output)'] : [])].join('\n'),
  };
};

/** What the source agent replied in the turn that answered the note request. */
export const agentNoteOf = (entries: readonly HistoryEntry[], turnRef: string): string =>
  entries
    .filter((e): e is Extract<HistoryEntry, { kind: 'message' }> => e.kind === 'message' && e.message.role === 'assistant' && e.message.turnId === turnRef && e.message.nativeTaskId === undefined)
    .map((e) => e.message.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');

/** The GUI's stored conversation as history entries, oldest first: used when the runtime's history cannot be read. */
export const entriesOf = (conversation: Conversation): HistoryEntry[] => {
  const timed: { at: string; entry: HistoryEntry }[] = [
    ...conversation.turns.map((turn) => ({ at: turn.startedAt, entry: { kind: 'turn', turn } as const })),
    ...conversation.messages.map((message) => ({ at: message.createdAt, entry: { kind: 'message', message } as const })),
    ...conversation.items.map((item) => ({ at: item.startedAt, entry: { kind: 'item', item } as const })),
  ];
  // Stable: records of one instant keep the order they were stored in.
  return timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((t) => t.entry);
};

/**
 * The source's content version (contracts have none, T023 G-2): how many records its conversation holds plus
 * how many of them ended. Records are only added and turns, items and sub-agents only end, so any new content
 * or end raises it. Read at the source's turn boundary, so the proposal binds what the user reviewed.
 */
export const contentVersion = (c: Conversation): number =>
  c.turns.length +
  c.messages.length +
  c.items.length +
  c.nativeTasks.length +
  c.turns.filter((t) => t.state !== 'running').length +
  c.items.filter((i) => i.endedAt !== undefined).length +
  c.nativeTasks.filter((t) => t.state !== 'running').length;

/** The fixed frame the new session receives (SP-09 T1, T2), built from the proposal alone. */
export const frameText = (proposal: Pick<TransferProposal, 'sourceSessionId' | 'target' | 'content'>, sourceRuntime: Runtime): string => {
  const { content, target } = proposal;
  const or = (text: string) => (text.trim().length > 0 ? text : '(none)');
  return [
    '[Transfer from another tool]',
    `This new session continues work begun in a ${sourceRuntime} session (${proposal.sourceSessionId}); the user confirmed the transfer.`,
    'Do not redo work that is already done: read the handoff below and check the current files first.',
    `Target: ${target.runtime} ${target.model}${target.effort !== undefined ? ` (effort ${target.effort})` : ''}`,
    '',
    '## Goal',
    content.goal,
    '',
    `## Handoff note (${content.noteSource === 'agent' ? 'written by the source agent' : 'compiled by the GUI from the source transcript'})`,
    or(content.note),
    '',
    '## Diff of the related changes',
    or(content.diff),
    '',
    '## Current test output',
    or(content.testOutput),
  ].join('\n');
};
