// Greets after `npm install -g phoneline`. npm 7+ hides install-script
// output, so this writes to the terminal device directly. It must never fail
// an install: any error (no build yet, no terminal, Windows) is ignored.
import { openSync, writeSync, closeSync, readFileSync } from "node:fs";

try {
  const { welcome, styleFor, shouldGreetOnInstall } = await import("./dist/welcome.js");
  if (shouldGreetOnInstall(process.env, process.platform)) {
    const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    const tty = openSync("/dev/tty", "w");
    try {
      writeSync(tty, `${welcome(version, styleFor(true))}\n`);
    } finally {
      closeSync(tty);
    }
  }
} catch {
  // Stay silent.
}
