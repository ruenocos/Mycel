import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { businessApply, businessPropose, businessSimulate } from "./business.ts";
import { shellArg } from "./input.ts";
import { runCli } from "./program.ts";
import { statusRun } from "./status.ts";

const fixtures = join(import.meta.dirname, "../../../fixtures/clients");

/** The test clients in the repo. De Saak's folder is client data and lives on the PC only. */
const CLIENTS = [
  { fixture: "plantpost", host: "plantpost.example" },
  { fixture: "praktijk-beweegruimte", host: "praktijkbeweegruimte.example" },
  { fixture: "dakwerken-maasstad", host: "dakwerkenmaasstad.example" },
];

const HOUR = 3_600_000;

describe("mycel status", () => {
  for (const client of CLIENTS) {
    it(`names the next command at every stage, for ${client.fixture}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "mycel-cli-status-"));
      const dir = join(root, client.host);
      mkdirSync(dir);
      const runsDir = join(root, "runs");
      const at = (file: string) => join(dir, file);
      // Every file a little newer than the one before, the way a real run leaves them.
      let clock = Date.now() - 24 * HOUR;
      const stamp = (file: string) => {
        clock += HOUR;
        utimesSync(at(file), new Date(clock), new Date(clock));
      };
      const put = (file: string, content = "{}") => {
        writeFileSync(at(file), content);
        stamp(file);
      };
      const next = () => statusRun({ dir, runsDir }).next ?? [];
      const commands = () => next().map((n) => n.command ?? `(${n.note})`);

      expect(commands()).toEqual([
        `mycel context propose https://${client.host} --out ${at("context.json")}`,
      ]);

      const context = JSON.parse(
        readFileSync(join(fixtures, client.fixture, "context.json"), "utf8"),
      );
      expect(new URL(context.site.url).hostname).toBe(client.host);
      put("context.json", JSON.stringify(context));
      expect(commands()).toEqual([`mycel context confirm ${at("context.json")}`]);

      const confirmed = { ...context, confirmed: { by: "Wons", at: "2026-11-14T08:00:00.000Z" } };
      put("context.json", JSON.stringify(confirmed));
      expect(next()).toEqual([
        {
          command: `mycel research ${at("context.json")}`,
          note: "a paid run: add --dry-run first to see the cost. Buying is a person's call",
        },
      ]);

      put("research.json");
      expect(commands()).toEqual([
        `mycel business propose ${at("context.json")} --site ${context.site.url}`,
        `mycel filter ${at("research.json")}`,
      ]);

      // The real business commands, on the fake model: status reads what they write.
      const proposal = await businessPropose({
        runsDir,
        contextFile: at("context.json"),
        site: join(fixtures, client.fixture),
        provider: "fake",
        model: "fake",
      });
      expect(proposal.out).toBe(at("business.proposed.json"));
      stamp("business.proposed.json");
      const waiting = next();
      expect(waiting[0]?.command).toBeUndefined();
      expect(waiting[0]?.note).toContain(`go in ${at("owner-answers.json")}`);
      expect(waiting[1]?.command).toBe(`mycel filter ${at("research.json")}`);

      businessSimulate({
        proposedFile: at("business.proposed.json"),
        keyFile: join(fixtures, client.fixture, "business.key.json"),
        language: "nl",
      });
      stamp("owner-answers.json");
      expect(commands()[0]).toBe(
        `mycel business apply ${at("business.proposed.json")} --answers ${at("owner-answers.json")}`,
      );

      businessApply({
        proposedFile: at("business.proposed.json"),
        answersFile: at("owner-answers.json"),
      });
      stamp("business.json");
      expect(commands()).toEqual([`mycel filter ${at("research.json")}`]);

      put("queries.json");
      expect(next()).toEqual([
        {
          command: `mycel cluster ${at("queries.json")} --dry-run`,
          note: "then the same with --live-serp --budget <usd> for what is missing. Buying is a person's call",
        },
      ]);

      put("clusters.json");
      expect(commands()).toEqual([`mycel signals ${at("clusters.json")} --dry-run`]);

      put("signals.json");
      expect(commands()).toEqual([`mycel map ${at("clusters.json")}`]);

      put("topical-map.json");
      const done = statusRun({ dir, runsDir });
      expect(done.next).toEqual([{ note: "nothing to do: every file is there and up to date" }]);
      expect(done.data).toMatchObject({ client: client.host, done: true, actions: [] });

      // The filter ran again after the clusters were made: they are flagged, and come next.
      stamp("queries.json");
      const stale = statusRun({ dir, runsDir });
      expect(stale.lines).toContain(
        "cluster     stale    older than queries.json, which it is made from",
      );
      expect(stale.next?.[0]?.command).toBe(`mycel cluster ${at("queries.json")} --dry-run`);
      expect(stale.data).toMatchObject({ done: false, actions: [{ step: "cluster" }] });
    });
  }

  it("prints a short screen, and refuses a folder that isn't there with a fix", async () => {
    const out: string[] = [];
    const err: string[] = [];
    let exitCode = 0;
    const io = {
      err: (s: string) => err.push(s),
      setExitCode: (c: number) => {
        exitCode = c;
      },
    };
    const folder = join(fixtures, "plantpost");
    await runCli(["node", "mycel", "status", folder], (s) => out.push(s), io);
    expect(exitCode).toBe(0);
    expect(out).toEqual([
      `client      plantpost.example  in ${folder}`,
      "context     waiting  proposed, not confirmed by a person yet",
      "research    missing  no research.json yet",
      "business    missing  no business profile yet",
      "filter      missing  no queries.json yet",
      "cluster     missing  no clusters.json yet",
      "signals     missing  no signals.json yet",
      "map         missing  no topical-map.json yet",
      // Quoted when the checkout's path has spaces, as on a Windows PC.
      `next        mycel context confirm ${shellArg(join(folder, "context.json"))}`,
    ]);

    await runCli(["node", "mycel", "status", join(folder, "nope")], (s) => out.push(s), io);
    expect(exitCode).toBe(3);
    expect(err.join("\n")).toContain("error       no client folder at ");
    expect(err.join("\n")).toContain(
      "fix         pass the folder that holds the client's context.json",
    );
  });
});
