import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (one level above src/ or dist/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
