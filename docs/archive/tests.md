# Test Summary

## Test Framework
- **Status**: Installed Vitest v4.1.9
- **Configuration**: Created `vitest.config.ts`
- **Scripts**: Updated test scripts in `package.json`
- **Files**: `packages/engram-js/vitest.config.ts`, `package.json`

## Unit Tests (Compaction)
- **Count**: 12 tests
- **Coverage**:
  - Truncation at 800/1200/1000 character thresholds
  - Boundary conditions
  - Duplicate tool call deduplication (keeps bookends)
  - Empty arrays
  - Array content validation
  - Early return below trigger threshold
  - Mocked compaction flow
- **File**: `tests/compactionEngine.test.ts`

## Integration Tests (Recall)
- **Count**: 14 tests
- **Coverage**:
  - Empty/whitespace query rejection
  - Invalid mode handling
  - Empty results handling
  - ILIKE parameter verification
  - User ID/project ID filters
  - Vector vs text recall comparison
  - Limit clamping (1–100)
  - Candidate IDs validation
  - Strict mode filters
  - Historical ordering
  - Row mapping
- **File**: `tests/recallDurableMemories.test.ts`

## Snapshot Tests (Schema)
- **Count**: 10 tests
- **Coverage**:
  - SQL array output validation
  - Custom schema/vector dimension handling
  - All tables presence verification
  - Deterministic output testing
  - Version/edge-type constants
  - 2 snapshot files committed
- **Files**: `tests/schema.test.ts`, `tests/__snapshots__/`

## Test Results
- **Total**: All 36 tests pass
- **Time**: 826ms
- **Test Files**: 3

## Running Tests
```bash
# Root (delegates via workspaces)
npm test

# Watch mode
cd packages/engram-js && npx vitest

# With coverage
cd packages/engram-js && npx vitest run --coverage
```