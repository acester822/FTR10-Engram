/*
 - filename
 - what is the file used for
*/

import { startServer } from "./api/index";
import { close_database } from "./database/connection";
import { logger } from "./utils/logger";

const server = startServer();

// Graceful shutdown: close DB pool on SIGTERM/SIGINT
const shutdown = async (signal: string) => {
  logger.info({ module: 'server', signal }, `Received ${signal} — shutting down gracefully`);
  try {
    await close_database();
    logger.info({ module: 'server' }, 'Database connections closed');
  } catch (err) {
    logger.error({ module: 'server', err }, 'Error closing database connections');
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => { 
  logger.fatal({ module: 'server' }, `FATAL UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason, promise) => { 
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.fatal({ module: 'server' }, `UNHANDLED REJECTION: ${msg.substring(0,500)}`);
});
