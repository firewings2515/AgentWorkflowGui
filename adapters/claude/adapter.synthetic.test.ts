// Session lifecycle on the fake SDK: start / resume options, startup failures, models, crashes, close.
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import { CWD, echo, expectValidEvents, init, loadStored, REF, result, setup, started, startOptions, until } from './testing/harness';

describe('startSession', () => {
  it('uses the GUI-chosen session ID and passes model, effort, instructions and read-only (CR2 §3, R-04)', async () => {
    const h = setup();
    await h.adapter.start();
    const info = await h.adapter.startSession(startOptions({ model: { runtime: 'claude', model: 'sonnet', effort: 'low' }, instructions: 'You review code.', readOnly: true }));
    expect(info).toEqual({ sessionId: 'session-a', nativeSessionRef: REF, cwd: CWD, model: { source: 'unknown' } });
    expect(h.sdk.last.options).toMatchObject({
      sessionId: REF,
      model: 'sonnet',
      effort: 'low',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You review code.' },
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    });
    await expect(h.adapter.startSession(startOptions())).rejects.toThrow(/already open/);
  });

  it('chooses a UUID when none is pre-allocated and refuses a malformed one', async () => {
    const h = setup();
    await h.adapter.start();
    const info = await h.adapter.startSession(startOptions({ preallocatedRef: undefined as never }));
    expect(info.nativeSessionRef).toMatch(/^[0-9a-f-]{36}$/);
    await expect(h.adapter.startSession(startOptions({ preallocatedRef: 'not-a-uuid' }))).rejects.toThrow(/UUID/);
    await expect(h.adapter.startSession(startOptions({ preallocatedRef: '22222222-2222-4222-8222-222222222222', model: { runtime: 'codex', model: 'gpt-6-luna' } }))).rejects.toThrow(/not a Claude model/);
  });

  it('refuses a cwd that no longer exists before starting the CLI (R-06)', async () => {
    const h = setup({ cwdExists: () => false });
    await h.adapter.start();
    await expect(h.adapter.startSession(startOptions())).rejects.toThrow(/does not exist/);
    expect(h.sdk.queries).toEqual([]);
  });

  it('closes the CLI and throws when it does not come up', async () => {
    const failing = setup();
    failing.sdk.behaviour.init = new Error('spawn claude.exe ENOENT');
    await failing.adapter.start();
    await expect(failing.adapter.startSession(startOptions())).rejects.toThrow(/did not start: spawn claude.exe ENOENT/);
    expect(failing.sdk.last.calls).toEqual(expect.arrayContaining(['interrupt', 'close']));

    const hanging = setup({ startTimeoutMs: 20 });
    hanging.sdk.behaviour.init = 'hang';
    await hanging.adapter.start();
    await expect(hanging.adapter.startSession(startOptions())).rejects.toThrow(/did not come up within 20 ms/);
    // The session can be opened again later: nothing is left registered.
    hanging.sdk.behaviour.init = 'ok';
    await expect(hanging.adapter.startSession(startOptions())).resolves.toMatchObject({ nativeSessionRef: REF });
  });

  it('needs start() first', async () => {
    const h = setup();
    await expect(h.adapter.startSession(startOptions())).rejects.toThrow(/not started/);
  });
});

describe('resumeSession', () => {
  const fx = loadStored('sp03-transcript.json');
  const resume = { sessionId: SessionId.parse('session-sp03'), nativeSessionRef: fx.sessionId, cwd: fx.cwd, model: { runtime: 'claude' as const, model: 'sonnet' }, readOnly: false };

  it('resumes in the original cwd and reports the last model the transcript shows', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries);
    await h.adapter.start();
    // The folder may be spelled differently (case, separators, trailing one).
    const info = await h.adapter.resumeSession({ ...resume, cwd: 'd:/DEMO/sp03/' });
    expect(info).toEqual({ sessionId: 'session-sp03', nativeSessionRef: fx.sessionId, cwd: 'd:/DEMO/sp03/', model: { source: 'per-message', model: 'claude-haiku-5-5', observedAt: '2026-10-23T08:58:55.800Z' } });
    expect(h.sdk.last.options).toMatchObject({ resume: fx.sessionId, cwd: 'd:/DEMO/sp03/', model: 'sonnet' });
    expect(h.sdk.last.options.sessionId).toBeUndefined();
  });

  it('refuses a session not found there, without starting the CLI', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries);
    await h.adapter.start();
    await expect(h.adapter.resumeSession({ ...resume, cwd: 'E:\\other' })).rejects.toThrow(/no stored Claude session .* under E:\\other/);
    h.sdk.readError = new Error('EBUSY');
    await expect(h.adapter.resumeSession(resume)).rejects.toThrow(/could not read session/);
    expect(h.sdk.queries).toEqual([]);
  });

  it('refuses another worktree, where the SDK still finds the session (R-06, SP-07)', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries, { alsoFoundFrom: ['D:\\demo\\sp03-wt2'] });
    await h.adapter.start();
    await expect(h.adapter.resumeSession({ ...resume, cwd: 'D:\\demo\\sp03-wt2' })).rejects.toThrow(/ran in D:\\demo\\sp03, not D:\\demo\\sp03-wt2/);
    expect(h.sdk.queries).toEqual([]);
  });
});

describe('models', () => {
  it('changes the model for the next model call and lists models from the CLI (R-12)', async () => {
    const models = [
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5' },
    ];
    const h = await started();
    h.sdk.behaviour.models = models;
    expect(await h.adapter.setModel(REF, { runtime: 'claude', model: 'opus', effort: 'max' })).toBe('next-model-call');
    expect(h.sdk.last.models).toEqual(['opus']);
    expect(h.sdk.last.flagSettings).toEqual([{ effortLevel: 'max' }]);
    await expect(h.adapter.setModel(REF, { runtime: 'codex', model: 'gpt-6-luna' })).rejects.toThrow(/not a Claude model/);
    await expect(h.adapter.setModel('33333333-3333-4333-8333-333333333333', { runtime: 'claude', model: 'opus' })).rejects.toThrow(/not open/);

    expect(await h.adapter.listModels()).toEqual([
      { runtime: 'claude', model: 'default', displayName: 'Default (recommended)', efforts: ['low', 'medium', 'high'], isDefault: true, hidden: false },
      { runtime: 'claude', model: 'haiku', displayName: 'Haiku', efforts: [], isDefault: false, hidden: false },
    ]);
    expect(h.sdk.queries).toHaveLength(1);
    // The next turn records the requested model it started with.
    h.sdk.last.emit(init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    expect(h.of('turn.updated')[0]!.turn.requestedModel).toEqual({ runtime: 'claude', model: 'opus', effort: 'max' });
  });

  it('lists models with a short-lived query when no session is open', async () => {
    const h = setup({ probeCwd: 'E:\\probe' });
    h.sdk.behaviour.models = [{ value: 'sonnet', displayName: 'Sonnet' }];
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    const probe = h.sdk.last;
    expect(probe.options).toMatchObject({ cwd: 'E:\\probe', settingSources: [], settings: { disableClaudeAiConnectors: true }, strictMcpConfig: true });
    expect(probe.inputs).toEqual([]);
    expect(probe.closed).toBe(true);
  });
});

describe('process end and close (R-14)', () => {
  it('a crash fails the running turn, closes open items and reports an unexpected exit', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init(), echo('x', '', { message: { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Running' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } }));
    await until(() => h.of('item.updated').length === 1, 'item');
    q.end(new Error('claude.exe crashed'));
    await until(() => h.of('runtime.exited').length === 1, 'exit');
    expect(h.of('message.completed').map((e) => e.message.text)).toEqual(['Running']);
    expect(h.of('item.updated').map((e) => e.item.state)).toEqual(['running', 'interrupted']);
    expect(h.of('turn.updated').at(-1)!.turn).toMatchObject({ state: 'failed', failure: { message: 'claude.exe crashed' } });
    expect(h.of('runtime.exited')[0]).toMatchObject({ runtime: 'claude', sessionIds: ['session-a'], expected: false, error: 'claude.exe crashed' });
    expect(h.of('session.activity').at(-1)!.activity).toBe('error');
    await expect(h.adapter.interrupt(REF)).rejects.toThrow(/not open/);
    expectValidEvents(h.events);
  });

  it('close interrupts the running turn first and reports forced when the CLI does not exit', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    h.sdk.behaviour.closeEnds = false;
    expect(await h.adapter.close(30)).toEqual({ forced: true });
    expect(q.calls.filter((c) => c === 'interrupt' || c === 'close')).toEqual(['interrupt', 'close']);
    expect(q.calls).toContain('input-ended');
  });

  it('closeSession releases one session; resume can bring it back', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init(), echo('y'), result());
    await until(() => h.of('turn.updated').length === 2, 'turn');
    expect(await h.adapter.closeSession(REF)).toEqual({ forced: false });
    expect(h.of('runtime.exited')).toEqual([expect.objectContaining({ expected: true })]);
    expect(h.of('session.activity').at(-1)!.activity).toBe('closed');
    expect(await h.adapter.closeSession(REF)).toEqual({ forced: false });
    expectValidEvents(h.events);
  });

  it('a malformed SDK message is logged and does not end the stream', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(null, { type: 'assistant', message: { content: 'not blocks' } }, { type: 'user', uuid: 'u-1', parent_tool_use_id: 'toolu_unknown', message: { role: 'user', content: 'x' } }, init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    expect(h.logs.some((l) => l.includes('unknown Agent call'))).toBe(true);
    expectValidEvents(h.events);
  });
});
