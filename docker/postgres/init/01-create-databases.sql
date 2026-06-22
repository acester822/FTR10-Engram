SELECT 'CREATE DATABASE engram'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'engram')\gexec
SELECT 'CREATE DATABASE langfuse'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')\gexec

\c engram
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

\c langfuse
-- Langfuse manages its own schema via Prisma migrations
