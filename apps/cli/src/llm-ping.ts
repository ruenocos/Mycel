import { FakeProvider, LlmClient, type LlmProvider, OllamaProvider } from "@mycel/connectors";
import { CORE_VERSION, RunStore } from "@mycel/core";
import { z } from "zod";
import type { CommandResult } from "./run-command.ts";

export interface PingOptions {
  runsDir: string;
  provider: string;
  model: string;
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

function providers(env: NodeJS.ProcessEnv): LlmProvider[] {
  const list: LlmProvider[] = [new FakeProvider([], '{"antwoord":"pong"}')];
  const host = env.OLLAMA_HOST ?? "https://ollama.com";
  list.push(
    new OllamaProvider({ host, ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}) }),
  );
  return list;
}

/** One logged LLM call inside a run, to check the provider, key and logging end to end. */
export async function llmPing(opts: PingOptions): Promise<CommandResult & { runId: string }> {
  const env = opts.env ?? process.env;
  const run = RunStore.create({
    runsDir: opts.runsDir,
    client: "none",
    command: "llm ping",
    cliVersion: CORE_VERSION,
    config: { provider: opts.provider, model: opts.model },
    ...(opts.debug ? { consoleLevel: "debug" as const } : {}),
  });
  const llm = new LlmClient({ providers: providers(env), defaultProvider: opts.provider });
  let failure: unknown;
  try {
    await run.step("llm-ping", async (ctx) =>
      llm.generateJson(
        {
          model: opts.model,
          template: { id: "llm-ping", version: "1" },
          params: { temperature: 0, seed: 1 },
          messages: [
            { role: "system", content: 'Antwoord alleen met JSON: {"antwoord": string}.' },
            { role: "user", content: "Zeg pong." },
          ],
        },
        z.object({ antwoord: z.string().min(1) }),
        ctx,
      ),
    );
  } catch (err) {
    failure = err;
  }
  run.finish(failure);
  return {
    runId: run.runId,
    ok: failure === undefined,
    lines: [],
    ...(failure !== undefined ? { failure } : {}),
  };
}
