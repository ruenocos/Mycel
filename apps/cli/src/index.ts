import { existsSync } from "node:fs";
import { buildProgram } from "./program.ts";

// Local keys (never committed). Real env vars win.
if (existsSync(".env")) process.loadEnvFile(".env");

await buildProgram().parseAsync(process.argv);
