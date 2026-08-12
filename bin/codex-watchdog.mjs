#!/usr/bin/env node

if (["menu", "--menu"].includes(process.argv[2])) {
  process.argv.splice(2, 1);
  const { runProjectMenu } = await import("../src/project-menu.mjs");
  await runProjectMenu();
} else if (["desktop-proxy", "--desktop-proxy"].includes(process.argv[2])) {
  process.argv.splice(2, 1);
  await import("../src/desktop-proxy.mjs");
} else {
  await import("../src/launcher.mjs");
}
