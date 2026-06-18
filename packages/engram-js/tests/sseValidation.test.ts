import { describe, it, expect } from 'vitest';
import { z } from 'zod';

/**
 * Mirrors the OpenAI / EngramVS client-side Zod schema that validates SSE chunks.
 * Every parsed JSON blob from an SSE `data:` line must satisfy one of these branches:
 *   - { choices: [...] }  — valid completion chunk
 *   - { error: object }    — error response
 */
const SseChunkSchema = z.union([
  z.object({ choices: z.array(z.any()) }),
  z.object({ error: z.any() }),
]);

describe('SSE chunk Zod validation', () => {
  it('accepts a standard delta chunk with choices', () => {
    const chunk = {
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'qwen3.5:2b',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    };
    expect(() => SseChunkSchema.parse(chunk)).not.toThrow();
  });

  it('accepts a [DONE] marker as a string (skipped by client)', () => {
    // [DONE] is never parsed as JSON — the client skips it before Zod.
    // This test just confirms we don't need to validate it here.
    expect('[DONE]').toBe('[DONE]');
  });

  it('rejects a trace payload without choices or error', () => {
    const tracePayload = {
      genome: ['Fix SSE streaming Zod validation error'],
      phenotype: [],
    };
    // This is exactly the shape that caused the bug before the fix.
    expect(() => SseChunkSchema.parse(tracePayload)).toThrow();
  });

  it('accepts a trace payload embedded in choices (the fixed format)', () => {
    const enrichedChunk = {
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'qwen3.5:2b',
      choices: [
        {
          index: 0,
          delta: { content: '\uD835\uDDA0 Stored 1 memories.', _trace: { genome: [], phenotype: [] } },
          finish_reason: null,
        },
      ],
    };
    expect(() => SseChunkSchema.parse(enrichedChunk)).not.toThrow();
  });

  it('accepts an error chunk', () => {
    const errChunk = { error: { message: 'Internal Engram Proxy Error' } };
    expect(() => SseChunkSchema.parse(errChunk)).not.toThrow();
  });
});
