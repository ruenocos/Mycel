import type { z } from "zod";

/**
 * What core steps need from an LLM client. The connectors' LlmClient satisfies it structurally,
 * so core stays independent of connectors (ADR 0001) and tests can pass a stub.
 */
export interface JsonModel {
  generateJson<S extends z.ZodType>(
    req: {
      model: string;
      template: { id: string; version: string };
      messages: { role: "system" | "user" | "assistant"; content: string }[];
      params?: { temperature?: number; topP?: number; seed?: number; maxTokens?: number };
    },
    schema: S,
    // biome-ignore lint/suspicious/noExplicitAny: the recorder shape belongs to connectors; core passes its StepContext
    rec: any,
    opts?: { maxAttempts?: number },
  ): Promise<z.output<S>>;
}
