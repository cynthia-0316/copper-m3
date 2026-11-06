// Starts scripts/build-index.ts. The app's code imports with "@/" paths, which
// plain Node doesn't know; jiti (already installed with ESLint and Vite) runs
// the TypeScript file and maps "@/" to the project folder.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll(
  "\\",
  "/",
);
const jiti = createJiti(import.meta.url, { alias: { "@/": root } });

try {
  const { main } = await jiti.import("./build-index.ts");
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
