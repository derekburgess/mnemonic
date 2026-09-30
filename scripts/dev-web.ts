import dotenv from "dotenv";
import { createServer } from "vite";
import { waitForApi } from "../server/devReadiness.js";

dotenv.config({ quiet: true });
const target = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
try {
  console.log(`[mnemonic] Waiting for API at ${target}…`);
  await waitForApi(target);
  const server = await createServer();
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
} catch (err) {
  console.error(`[mnemonic] ${(err as Error).message}`);
  process.exit(1);
}
