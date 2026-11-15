import { defineConfig } from "tsdown";

// The published build (ADR 0018). In this repo the source is used directly.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
});
