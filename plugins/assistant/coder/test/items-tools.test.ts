// Outils des éléments de l'assistant des réglages : noms, arguments et valeurs en anglais, de bout en bout (la demande montrée à l'utilisateur comprise).
import { describe, expect, it } from "vitest";
import { itemsTools } from "../src/items-tools.ts";

describe("outils des éléments (assistant des réglages)", () => {
  const asked: { tool: string; input: Record<string, unknown> }[] = [];
  const ran: unknown[] = [];
  const ctx = { items: { snapshot: async () => [], run: async (op: unknown) => { ran.push(op); return { ok: true, text: "fait", id: "x" }; } } } as never;
  const tools = itemsTools(ctx, async (req) => { asked.push(req as never); return true; });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const props = (name: string) => Object.keys((tool(name).inputSchema as { properties: Record<string, unknown> }).properties);

  it("noms et arguments", () => {
    expect(tools.map((t) => t.name)).toEqual(["list_item_types", "add_item", "edit_item", "delete_item", "try_item"]);
    expect(props("list_item_types")).toEqual(["section"]);
    expect(props("add_item")).toEqual(["provider", "type", "values"]);
    expect(props("edit_item")).toEqual(["provider", "id", "values"]);
    expect(props("delete_item")).toEqual(["provider", "id"]);
    expect(props("try_item")).toEqual(["provider", "type", "values"]);
  });

  it("add_item : la demande montrée et l'opération partent avec les noms anglais", async () => {
    asked.length = 0; ran.length = 0;
    const r = await tool("add_item").handler({ provider: "connectors", type: "mcp-local", values: { label: "Notes", token: "secret" } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: "add_item", input: { provider: "connectors", type: "mcp-local", values: { label: "Notes" } } });
    expect(ran).toEqual([{ op: "add", provider: "connectors", kind: "mcp-local", values: { label: "Notes", token: "secret" } }]);
    expect(r.isError).toBeFalsy();
  });

  it("edit_item, delete_item, try_item : les noms de la demande", async () => {
    asked.length = 0;
    await tool("edit_item").handler({ provider: "connectors", id: "a", values: { label: "B" } });
    await tool("delete_item").handler({ provider: "connectors", id: "a" });
    await tool("try_item").handler({ provider: "connectors", type: "mcp-local", values: {} });
    expect(asked.map((a) => a.tool)).toEqual(["edit_item", "delete_item", "try_item"]);
    expect(asked[0]!.input).toEqual({ provider: "connectors", id: "a", values: { label: "B" } });
  });
});
