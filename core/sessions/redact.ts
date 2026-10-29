// Keeps the MCP tokens this process handed out out of everything a runtime reports (C-07, T017 r1-P1-2 and
// r2-P1-2). A token is matched as written and in the encodings a runtime might quote it in: percent-encoded
// (encodeURIComponent, and every character as %XX) and JSON \uXXXX escapes. Streaming deltas are held back
// by the length of the longest of those forms minus one, so a token split across deltas is still found;
// what is held is let out, redacted, only at its own end (r3-P1-1): a message's at its completion, the end
// of its own turn or of its own native sub-agent; an item's output at the end of that item; and everything
// of a session when its runtime exits. Another turn ending (a sub-agent's, say) lets nothing out.
//
// Accepted residual risk (main session): Base64 and other deliberate encodings are not matched. A token
// is valid only on loopback, for this one session, until its next start or resume.
import type { RuntimeEvent } from '../ports';

export const REDACTED = '[redacted]';

const hex = (c: string) => c.charCodeAt(0).toString(16).padStart(2, '0');
const unicode = (c: string) => c.charCodeAt(0).toString(16).padStart(4, '0');

/** Every spelling of a token that is matched. */
export const tokenForms = (token: string): string[] => {
  const chars = [...token];
  const forms = [
    token,
    encodeURIComponent(token),
    chars.map((c) => `%${hex(c).toUpperCase()}`).join(''),
    chars.map((c) => `%${hex(c)}`).join(''),
    chars.map((c) => `\\u${unicode(c)}`).join(''),
    chars.map((c) => `\\u${unicode(c).toUpperCase()}`).join(''),
  ];
  return [...new Set(forms)];
};

type Delta = Extract<RuntimeEvent, { type: 'message.delta' | 'item.outputDelta' }>;

interface Stream {
  kind: 'message' | 'item';
  sessionId: string;
  /** For a message: the turn and the native sub-agent it belongs to, whose end lets it out. */
  turnId?: string;
  nativeTaskId?: string;
  tail: string;
  last: Delta;
}

/** A key no two (kind, session, ID) share, whatever the IDs contain (r3-P2-1). */
const keyOf = (kind: Stream['kind'], sessionId: string, id: string) => JSON.stringify([kind, sessionId, id]);

export class Redactor {
  /** Longest first, so a longer spelling is replaced before a shorter one inside it. */
  private forms: string[] = [];
  private readonly streams = new Map<string, Stream>();

  /** Every token handed out stays here, revoked ones included. */
  add(token: string): void {
    this.forms = [...new Set([...this.forms, ...tokenForms(token)])].sort((a, b) => b.length - a.length);
  }

  get active(): boolean {
    return this.forms.length > 0;
  }

  text(text: string): string {
    let out = text;
    for (const form of this.forms) if (out.includes(form)) out = out.split(form).join(REDACTED);
    return out;
  }

  /** A copy of plain data with every token redacted from every string in it. */
  value<T>(value: T): T {
    if (!this.active) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.text(v);
      if (Array.isArray(v)) return v.map(walk);
      if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value) as T;
  }

  /** What to pass on for one adapter event: none, the event, or held delta text first and then the event. */
  events(event: RuntimeEvent): RuntimeEvent[] {
    switch (event.type) {
      case 'message.delta':
        return this.stream(keyOf('message', event.sessionId, event.messageId), 'message', event);
      case 'item.outputDelta':
        return this.stream(keyOf('item', event.sessionId, event.itemId), 'item', event);
      case 'message.completed':
        return [...this.flush(keyOf('message', event.message.sessionId, event.message.id)), this.value(event)];
      case 'item.updated': {
        const open = event.item.kind === 'fileChange' ? event.item.state === 'proposed' : event.item.state === 'running';
        return [...(open ? [] : this.flush(keyOf('item', event.item.sessionId, event.item.id))), this.value(event)];
      }
      case 'turn.updated': {
        // Only the messages of this very turn (r3-P1-1).
        const { turn } = event;
        return [...(turn.state === 'running' ? [] : this.flushWhere((s) => s.kind === 'message' && s.sessionId === turn.sessionId && s.turnId === turn.id)), this.value(event)];
      }
      case 'nativeTask.updated': {
        // A sub-agent's messages without a turn end with the sub-agent.
        const { task } = event;
        return [...(task.state === 'running' ? [] : this.flushWhere((s) => s.kind === 'message' && s.sessionId === task.sessionId && s.nativeTaskId === task.id)), this.value(event)];
      }
      case 'runtime.exited':
        return [...this.flushWhere((s) => (event.sessionIds as readonly string[]).includes(s.sessionId)), this.value(event)];
      default:
        return [this.value(event)];
    }
  }

  private get holdBack(): number {
    return Math.max(0, (this.forms[0]?.length ?? 0) - 1);
  }

  private stream(key: string, kind: Stream['kind'], event: Delta): RuntimeEvent[] {
    const held = this.streams.get(key);
    const text = this.text((held?.tail ?? '') + event.delta);
    const keep = Math.min(this.holdBack, text.length);
    // Any spelling not complete yet starts within the last `holdBack` characters, so the rest is safe.
    const out = text.slice(0, text.length - keep);
    const tail = text.slice(text.length - keep);
    if (tail === '') this.streams.delete(key);
    else
      this.streams.set(key, {
        kind,
        sessionId: event.sessionId,
        ...(event.type === 'message.delta' && event.turnId !== undefined && { turnId: event.turnId }),
        ...(event.type === 'message.delta' && event.nativeTaskId !== undefined && { nativeTaskId: event.nativeTaskId }),
        tail,
        last: event,
      });
    return out === '' ? [] : [{ ...event, delta: out }];
  }

  private flush(key: string): RuntimeEvent[] {
    const held = this.streams.get(key);
    this.streams.delete(key);
    if (held === undefined) return [];
    const delta = this.text(held.tail);
    return delta === '' ? [] : [{ ...held.last, delta }];
  }

  private flushWhere(match: (stream: Stream) => boolean): RuntimeEvent[] {
    return [...this.streams.entries()].filter(([, s]) => match(s)).flatMap(([key]) => this.flush(key));
  }
}
