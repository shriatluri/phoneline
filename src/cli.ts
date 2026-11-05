#!/usr/bin/env node
import { runInit, runUninstall } from "./init.js";
import { startStdioServer } from "./server.js";

const USAGE = `Usage: phoneline [command]

Commands:
  serve       Run the MCP server over stdio (default)
  init        Register phoneline with Claude Code for every repo (re-run after a Node upgrade)
  uninstall   Remove phoneline from Claude Code; keeps ~/.phoneline`;

async function main(argv: string[]): Promise<void> {
  const [command = "serve"] = argv;

  switch (command) {
    case "serve":
      await startStdioServer();
      break;
    case "init":
      process.exitCode = runInit();
      break;
    case "uninstall":
      process.exitCode = runUninstall();
      break;
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
