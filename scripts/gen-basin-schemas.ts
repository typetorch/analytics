// Writes basin/events.schema.json and basin/recordings.schema.json from src/schema.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { basinSchemaFiles } from "../src/basin/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [path, text] of Object.entries(basinSchemaFiles())) {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	console.log(`wrote ${path}`);
}
