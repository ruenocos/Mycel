import { CORE_VERSION } from "@mycel/core";
import { Command } from "commander";

export function buildProgram(): Command {
  return new Command()
    .name("mycel")
    .description("Build a data-driven topical map. A human approves everything.")
    .version(CORE_VERSION);
}
