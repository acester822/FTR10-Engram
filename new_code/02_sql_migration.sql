-- Raw SQL Migration (compatible with both SQLite and PostgreSQL)
-- File: migrations/002_cognitive_memory.sql

-- 1. Add Cognitive Columns
-- Note: For SQLite, IF NOT EXISTS on ADD COLUMN requires SQLite 3.33.0+. 
-- If using older SQLite, just remove "IF NOT EXISTS".
ALTER TABLE memories ADD COLUMN IF NOT EXISTS is_genome BOOLEAN DEFAULT FALSE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_rate REAL DEFAULT 0.1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS consolidation_hash TEXT;

-- 2. Create Indexes for Performance
-- Speeds up the "Genome" fetch (which happens on every single request)
CREATE INDEX IF NOT EXISTS idx_memories_genome ON memories(is_genome);

-- Speeds up the background consolidation job (finding old episodic memories)
CREATE INDEX IF NOT EXISTS idx_memories_consolidation ON memories(sector, created_at);

-- 3. Optional: Seed a default Genome memory (Example)
-- INSERT INTO memories (content, sector, is_genome, decay_rate) 
-- VALUES ('User prefers functional React components and TypeScript.', 'semantic', TRUE, 0.0);
