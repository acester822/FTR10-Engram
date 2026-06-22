import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactionEngine } from '../src/services/compactionEngine';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMsg(
  role: string,
  content: string | any[],
  overrides: Record<string, any> = {},
) {
  return { role, content, ...overrides };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('CompactionEngine – thinMessages', () => {
  let engine: CompactionEngine;

  beforeEach(() => {
    // Access private method via cast for direct unit testing
    engine = new CompactionEngine();
  });

  it('passes through short messages unchanged', () => {
    const msgs = [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi there'),
    ];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin).toEqual(msgs);
  });

  it('truncates tool outputs over 800 chars', () => {
    const long = 'x'.repeat(900);
    const msgs = [makeMsg('tool', long)];
    const thin = (engine as any).thinMessages(msgs);
    // substring(0,800) + '\n... [TRUNCATED]' = 800 + 16 = 816
    expect(thin[0].content).toHaveLength(816);
    expect(thin[0].content).toMatch(/\.\.\. \[TRUNCATED\]$/);
  });

  it('truncates assistant responses over 1200 chars', () => {
    const long = 'y'.repeat(1500);
    const msgs = [makeMsg('assistant', long)];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin[0].content).toHaveLength(1216);
    expect(thin[0].content).toMatch(/\.\.\. \[TRUNCATED\]$/);
  });

  it('truncates user messages over 1000 chars', () => {
    const long = 'z'.repeat(1100);
    const msgs = [makeMsg('user', long)];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin[0].content).toHaveLength(1016);
    expect(thin[0].content).toMatch(/\.\.\. \[TRUNCATED\]$/);
  });

  it('does NOT truncate messages under the threshold', () => {
    const msgs = [
      makeMsg('tool', 'x'.repeat(799)),
      makeMsg('assistant', 'y'.repeat(1199)),
      makeMsg('user', 'z'.repeat(999)),
    ];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin[0].content).toHaveLength(799);
    expect(thin[1].content).toHaveLength(1199);
    expect(thin[2].content).toHaveLength(999);
  });

  it('removes consecutive duplicate tool calls (keeps bookends)', () => {
    const msgs = [
      makeMsg('user', 'what time is it'),
      makeMsg('assistant', 'let me check'),
      makeMsg('tool', 'result a'),
      makeMsg('tool', 'result b'),
      makeMsg('tool', 'result c'),
      makeMsg('assistant', 'the time is X'),
    ];
    const thin = (engine as any).thinMessages(msgs);
    // Algorithm keeps first tool (follows non-tool) and last tool (precedes non-tool)
    const toolMsgs = thin.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].content).toBe('result a');
    expect(toolMsgs[1].content).toBe('result c');
  });

  it('does not remove non-consecutive tool calls', () => {
    const msgs = [
      makeMsg('user', 'a'),
      makeMsg('tool', 'result a'),
      makeMsg('assistant', 'thanks'),
      makeMsg('tool', 'result b'),
    ];
    const thin = (engine as any).thinMessages(msgs);
    const toolMsgs = thin.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
  });

  it('handles empty message array', () => {
    const thin = (engine as any).thinMessages([]);
    expect(thin).toEqual([]);
  });

  it('handles array content gracefully', () => {
    const msgs = [makeMsg('user', [{ type: 'text', text: 'hello' }])];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('handles a single trailing tool message (keeps it)', () => {
    const msgs = [
      makeMsg('user', 'x'),
      makeMsg('tool', 'only tool'),
    ];
    const thin = (engine as any).thinMessages(msgs);
    expect(thin).toHaveLength(2);
    expect(thin[1].content).toBe('only tool');
  });
});

describe('CompactionEngine – compactIfNeeded', () => {
  let engine: CompactionEngine;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    engine = new CompactionEngine();
    // Mock fetch to avoid real Ollama calls
    fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: '{"summary":"test","facts":[]}' }),
    });
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns messages unchanged when count is below trigger', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg('user', `msg ${i}`));
    const result = await engine.compactIfNeeded(msgs);
    expect(result.messages).toBe(msgs);
    expect(result.extractedFactCount).toBe(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('does not throw when called with many messages', async () => {
    const msgs = Array.from({ length: 60 }, (_, i) => makeMsg('user', `msg ${i}`));
    await expect(engine.compactIfNeeded(msgs)).resolves.toBeDefined();
    expect(fetchStub).toHaveBeenCalled();
  });
});
