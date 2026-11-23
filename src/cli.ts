#!/usr/bin/env node
import { runInit, runUninstall } from "./init.js";
import { VERSION, startStdioServer } from "./server.js";
import { defaultCommand, styleFor, welcome } from "./welcome.js";

const USAGE = `Usage: phoneline [command]

Commands:
  serve       Run the MCP server over stdio (default when not in a terminal)
  init        Register phoneline with Claude Code for every repo (re-run after a Node upgrade)
  uninstall   Remove phoneline from Claude Code; keeps ~/.phoneline
  welcome     Show the quick tour (default in a terminal)`;

async function main(argv: string[]): Promise<void> {
  const [command = defaultCommand(!!process.stdin.isTTY)] = argv;

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
    case "welcome":
      console.log(`${welcome(VERSION, styleFor(!!process.stdout.isTTY))}\n${USAGE}\n`);
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
