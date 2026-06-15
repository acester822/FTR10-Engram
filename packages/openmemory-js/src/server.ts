/*
   ____                   __  __                                 
  / __ \                 |  \/  |                                
 | |  | |_ __   ___ _ __ | \  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \ / _ \ '_ \| |\/| |/ _ \ '_ ` _ \ / _ \| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \____/| .__/ \___|_| |_|_|  |_|\___|_| |_| |_|\___/|_|   \__, |
        | |                                                 __/ |
        |_|                                                |___/ 
  CaviraOSS @ 2026

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
