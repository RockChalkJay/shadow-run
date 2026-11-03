import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultEdgeCatalog, EdgeCatalog, findEdgeEntry, loadEdgeCatalog } from "../../src/rules/index.js";

const byKind = (kind: string) => defaultEdgeCatalog.entries.filter((e) => e.kind === kind);
const costs = (kind: string) => byKind(kind).map((e) => e.cost).sort((a, b) => a - b);

describe("the Edge catalog", () => {
  it("is valid", () => {
    expect(EdgeCatalog.safeParse(defaultEdgeCatalog).success).toBe(true);
  });

  it("has the twelve boosts at the costs the rulebook lists", () => {
    expect(costs("boost")).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5]);
  });

  it("has the twelve Edge Actions at the costs the rulebook lists", () => {
    expect(costs("action")).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 5, 5]);
  });

  it("has the two ways to burn Edge", () => {
    expect(byKind("burn").map((e) => e.id).sort()).toEqual(["not_dead_yet", "smackdown"]);
  });

  it("marks which boosts are declared before the roll, after it, or either", () => {
    const timing = (id: string) => findEdgeEntry(id)?.timing;
    expect(timing("reroll_one_die")).toBe("post");
    expect(timing("reroll_failed")).toBe("post");
    expect(timing("edge_dice_explode")).toBe("pre");
    expect(timing("widen_glitch")).toBe("pre");
    expect(timing("buy_hit")).toBe("any");
  });

  it("names what each Edge Action must accompany", () => {
    expect(findEdgeEntry("fire_from_cover")?.requires).toMatch(/Cover IV/);
    expect(byKind("action").every((e) => e.requires && e.effect === "gm")).toBe(true);
  });

  it("looks entries up by id", () => {
    expect(findEdgeEntry("buy_hit")?.cost).toBe(3);
    expect(findEdgeEntry("nope")).toBeUndefined();
  });
});

describe("loadEdgeCatalog", () => {
  it("refuses a catalog with a repeated id", async () => {
    const entry = { ...defaultEdgeCatalog.entries[0]! };
    const dir = await mkdtemp(join(tmpdir(), "sr-edge-"));
    const file = join(dir, "edge.json");
    await writeFile(file, JSON.stringify({ entries: [entry, entry] }));
    expect(() => loadEdgeCatalog(pathToFileURL(file))).toThrow(/unique/);
  });
});
