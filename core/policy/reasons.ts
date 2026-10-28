// Fixed reason texts for escalations (T014). A reason never quotes the command, a path, file contents or
// a secret: the root screen shows the request itself next to it.
import type { PolicyRule } from '../ports';

export const REASONS = {
  'outside-write': 'Writes or deletes a path outside the folder scope.',
  'git-remote': 'Pushes to a git remote or changes a remote.',
  'wide-delete': 'Deletes recursively or by wildcard.',
  'git-discard': 'Discards git history, branches or uncommitted work.',
  'system-settings': 'Changes system settings, services or other processes.',
  'global-install': 'Installs or removes packages outside the project.',
  secret: 'Reads or touches a credential or secret file.',
  'secret-mention': 'Names a credential or secret file in a command the policy cannot analyse.',
  'outside-read': 'Reads a path outside the folder scope, where secret files cannot be ruled out.',
  'one-liner': 'Runs inline interpreter code.',
  encoded: 'Runs an encoded command.',
  'written-script': 'Runs a file this session wrote.',
  'nested-shell': 'Starts another shell or launcher whose command is not analysed.',
  syntax: 'Uses shell syntax the policy cannot analyse, such as variables, subexpressions or unusual quoting.',
  option: 'Uses an option the policy cannot analyse.',
  'unknown-target': 'Cannot determine the target path.',
  link: 'Creates a symbolic link or junction.',
  'unknown-program': 'Runs a program or subcommand the policy does not recognise.',
  'unknown-tool': 'Uses a tool the policy does not recognise.',
  grant: 'Asks for extra sandbox permissions.',
  elicitation: 'An MCP server asks the user for input.',
  'no-command': 'The request does not include the command to check.',
} as const;

export type ReasonKey = keyof typeof REASONS;

export interface Finding {
  rule: PolicyRule;
  why: ReasonKey;
}

export const finding = (rule: PolicyRule, why: ReasonKey): Finding => ({ rule, why });
