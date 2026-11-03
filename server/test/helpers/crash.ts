// Run by a test, in its own process: starts a GM turn and then exits at once with no cleanup,
// the way a crashed server would.
import { runGmTurn } from "../../src/gm/claudeProcess.js";

const turn = runGmTurn({ prompt: "x", cwd: process.cwd(), claudeBin: process.env.CRASH_BIN! });
await turn.next(); // the first event, so the process is certainly running
process.exit(0);
