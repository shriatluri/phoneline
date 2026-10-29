#!/usr/bin/env node
import { startStdioServer } from "./server.js";

const USAGE = `Usage: phoneline [command]

Commands:
  serve   Run the MCP server over stdio (default)
  init    Set up phoneline in this repo (not implemented yet)`;

async function main(argv: string[]): Promise<void> {
  const [command = "serve"] = argv;

  switch (command) {
    case "serve":
      await startStdioServer();
      break;
    case "init":
      // SHRI-27 implements this.
      console.log("phoneline init: not implemented yet");
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
