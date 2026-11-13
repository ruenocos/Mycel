/** All SEO logic lives in core; apps are thin shells around it (ADR 0001). */
export { SCHEMA_VERSION } from "@mycel/schema";
export * from "./context/index.ts";
export * from "./evals/writing.ts";
export * from "./filter/index.ts";
export * from "./log/index.ts";
export * from "./research/index.ts";
export * from "./step.ts";

export const CORE_VERSION = "0.0.0";
