/*
 - filename
 - what is the file used for
*/

import { startServer } from "./api/index";

startServer();

process.on('uncaughtException', (err) => { 
  console.error('[FATAL UNCAUGHT]', err.stack || err.message);
});
process.on('unhandledRejection', (reason, promise) => { 
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error('[UNHANDLED REJECTION]', msg.substring(0,500));
});
