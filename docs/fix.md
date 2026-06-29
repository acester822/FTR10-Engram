# In `memoryLogger.ts`, update the OUTPUT SCHEMA section:

``` ts
OUTPUT SCHEMA:
Return ONLY a valid JSON array of objects. Each object MUST have a "content" field and a "sector" field.
Do NOT include any other values, strings, or primitives in the array - ONLY objects.

Example of CORRECT output:
[
  {
    "content": "The user prefers TypeScript over JavaScript",
    "sector": "semantic"
  },
  {
    "content": "Always run tests before committing",
    "sector": "procedural"
  }
]

Example of INCORRECT output (DO NOT DO THIS):
[
  { "content": "something" },
  "remember": true,  ← WRONG! This breaks JSON
  "save": true       ← WRONG! This breaks JSON
]
```

# In `compactionEngine.ts`, do this:

``` ts
public async compactIfNeeded(messages: Message[]): Promise<CompactionResult> {
  if (messages.length <= COMPACTION_TRIGGER) {
    return { messages, extractedFactCount: 0 };
  }

  const oldMessages = messages.slice(0, messages.length - MAX_RAW_TURNS);
  let recentMessages = messages.slice(-MAX_RAW_TURNS);

  logger.info(
    { module: 'compactionEngine', oldMessageCount: oldMessages.length, model: COMPACTION_MODEL },
    'Triggering context compaction'
  );

  // 🛡️ CRITICAL: Ensure tool call/result pairs are not split across the boundary
  recentMessages = this.fixToolCallBoundaries(messages, recentMessages);

  // 🛡️ CRITICAL FIX: Find and preserve the most recent user message from oldMessages
  // Search backwards through old messages to find the last user query
  const lastUserMessage = oldMessages.slice().reverse().find(m => m.role === 'user');
  
  if (lastUserMessage) {
    // Prepend the user message to recent messages to preserve context
    recentMessages = [lastUserMessage, ...recentMessages];
    logger.info(
      { module: 'compactionEngine' },
      'Preserved user message from old history'
    );
  } else if (!recentMessages.some(m => m.role === 'user')) {
    // No user message anywhere - this is a critical error
    logger.error(
      { module: 'compactionEngine' },
      'No user message found in entire conversation history'
    );
  }

  const thinnedHistory = this.thinMessages(oldMessages);
  const { summary, extractedFacts } = await this.generateSummaryAndExtract(thinnedHistory);

  let savedCount = 0;
  if (extractedFacts.length > 0) {
    savedCount = await this.saveExtractedFacts(extractedFacts);
    logger.info(
      { module: 'compactionEngine', count: savedCount },
      'Compaction extracted and saved new phenotype memories'
    );
  }

  const safeSummary = this.sanitizeSummary(summary);
  const compactedSystemMessage: Message = {
    role: "system",
    content: `[COMPACTED SESSION SUMMARY]\n${safeSummary}\n[END COMPACTED SUMMARY]`,
  };

  const finalMessages = this.validateMessageStructure([compactedSystemMessage, ...recentMessages]);

  return {
    messages: finalMessages,
    extractedFactCount: savedCount,
  };
}
```