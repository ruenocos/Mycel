/** All SEO logic lives in core; apps are thin shells around it (ADR 0001). */
import pkg from "../package.json" with { type: "json" };

export { SCHEMA_VERSION } from "@mycel/schema";
export * from "./cluster/index.ts";
export * from "./context/index.ts";
export * from "./evals/map.ts";
export * from "./evals/map-review.ts";
export * from "./evals/writing.ts";
export * from "./filter/index.ts";
export * from "./log/index.ts";
export * from "./map/index.ts";
export * from "./pipeline/status.ts";
export * from "./research/index.ts";
export * from "./step.ts";

/** The engine version (ADR 0018): one version for every engine package, read from package.json. */
export const CORE_VERSION: string = pkg.version;
