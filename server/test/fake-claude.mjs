#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Replays a recorded stream so the suite never
// spends real quota. Configure through the environment:
//   FAKE_CLAUDE_FIXTURE   path of a .jsonl file to print on stdout
//   FAKE_CLAUDE_CAPTURE   path to write { args, stdin, pid, envKeys } as JSON, where envKeys
//                         lists the ANTHROPIC_* and CLAUDE_CODE_USE_* variables it was given
//   FAKE_CLAUDE_EXIT      exit code (default 0)
//   FAKE_CLAUDE_STDERR    text to print on stderr
//   FAKE_CLAUDE_HANG      if set, keep running after printing, until killed
import { readFileSync, writeFileSync } from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const { FAKE_CLAUDE_FIXTURE, FAKE_CLAUDE_CAPTURE, FAKE_CLAUDE_EXIT, FAKE_CLAUDE_STDERR, FAKE_CLAUDE_HANG } =
  process.env;

if (FAKE_CLAUDE_CAPTURE) {
  writeFileSync(
    FAKE_CLAUDE_CAPTURE,
    JSON.stringify({
      args: process.argv.slice(2),
      stdin,
      pid: process.pid,
      envKeys: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)),
    }),
  );
}
if (FAKE_CLAUDE_FIXTURE) process.stdout.write(readFileSync(FAKE_CLAUDE_FIXTURE, "utf8"));
if (FAKE_CLAUDE_STDERR) process.stderr.write(FAKE_CLAUDE_STDERR);
if (FAKE_CLAUDE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(FAKE_CLAUDE_EXIT ?? 0);
