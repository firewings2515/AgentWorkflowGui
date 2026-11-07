// @vitest-environment jsdom
// T064: the 「返工上限」 field says how rework is counted (one loop back to a node is one), and a new template keeps a
// limit that allows two send-backs.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { REWORK_LIMIT_HINT, WorkflowSettings, workflowFieldId } from './WorkflowInspector';
import { createWorkflowDraft } from './workflow-editor-state';

afterEach(cleanup);

describe('T064 the rework limit field', () => {
  const workflow = createWorkflowDraft(fixtureSnapshot.agents, fixtureSnapshot.modelOptions, '2026-11-07T00:00:00.000Z');

  it('a new template allows two send-backs', () => {
    expect(workflow.reworkLimit).toBe(2);
  });

  it('says next to the field how rework is counted, linked as its description', () => {
    render(<WorkflowSettings workflow={workflow} issues={[]} onChange={() => undefined} onRoot={() => undefined} />);
    expect(REWORK_LIMIT_HINT).toContain('task 每繞回同一個節點一次算 1 次');
    const field = screen.getByLabelText('返工上限');
    const hint = screen.getByText(REWORK_LIMIT_HINT);
    expect(hint.id).toBe(`${workflowFieldId('reworkLimit')}-hint`);
    expect(field.getAttribute('aria-describedby')).toBe(hint.id);
    // Other fields have no hint.
    expect(screen.getByLabelText('範本名稱').getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the hint described next to an error', () => {
    render(<WorkflowSettings workflow={{ ...workflow, reworkLimit: Number.NaN }} issues={[{ path: 'reworkLimit', message: '請輸入大於或等於 0 的整數。' }]} onChange={() => undefined} onRoot={() => undefined} />);
    const id = workflowFieldId('reworkLimit');
    expect(screen.getByLabelText('返工上限').getAttribute('aria-describedby')).toBe(`${id}-hint ${id}-error`);
    expect(screen.getByText('請輸入大於或等於 0 的整數。').id).toBe(`${id}-error`);
  });
});
