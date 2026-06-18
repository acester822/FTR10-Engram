/*
 - filename
 - what is the file used for
*/

import { startServer } from "./api/index";
import { logger } from "./utils/logger";

startServer();

process.on('uncaughtException', (err) => { 
  logger.fatal({ module: 'server' }, `FATAL UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason, promise) => { 
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.fatal({ module: 'server' }, `UNHANDLED REJECTION: ${msg.substring(0,500)}`);
});
