// Historique de session : échanges (et non messages), résultats d'outils anciens raccourcis.
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { compactHistory, splitExchanges, OLD_TOOL_CHARS } from "../src/history.ts";

const user = (t: string): ModelMessage => ({ role: "user", content: t });
const reply = (t: string): ModelMessage => ({ role: "assistant", content: t });
const call = (id: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_mail", input: {} }] });
const result = (id: string, value: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_mail", output: { type: "text", value } }] });
const toolTexts = (ms: ModelMessage[]) => ms.flatMap((m) => (m.role === "tool" ? m.content.map((p) => (p.type === "tool-result" ? (p.output as { value: string }).value : "")) : []));

describe("historique compté en échanges", () => {
  it("un échange = une demande et tout ce qui suit jusqu'à la suivante", () => {
    const ex = splitExchanges([user("a"), call("1"), result("1", "x"), reply("A"), user("b"), reply("B")]);
    expect(ex.map((e) => e.length)).toEqual([4, 2]);
  });
  it("un tour avec trois outils ne mange pas le budget : 8 échanges restent 8 échanges", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(user(`q${i}`), call(`a${i}`), result(`a${i}`, "ok"), call(`b${i}`), result(`b${i}`, "ok"), call(`c${i}`), result(`c${i}`, "ok"), reply(`r${i}`));
    const kept = compactHistory(messages, 8);
    expect(kept.filter((m) => m.role === "user")).toHaveLength(8);
    expect(kept[0]).toEqual(user("q2"));
    expect(kept.at(-1)).toEqual(reply("r9"));
  });
  it("jamais de résultat d'outil orphelin en tête", () => {
    const kept = compactHistory([result("0", "orphelin"), reply("x"), user("a"), reply("A")], 8);
    expect(kept).toEqual([user("a"), reply("A")]);
  });
  it("raccourcit les résultats d'outils des échanges anciens, pas ceux du dernier", () => {
    const big = "m".repeat(5000);
    const kept = compactHistory([user("a"), call("1"), result("1", big), reply("A"), user("b"), call("2"), result("2", big), reply("B")], 8);
    const [old, last] = toolTexts(kept);
    expect(old!.length).toBe(OLD_TOOL_CHARS + 1);
    expect(old!.endsWith("…")).toBe(true);
    expect(last).toBe(big);
  });
  it("un résultat court ou un JSON court reste intact ; un grand JSON devient du texte borné", () => {
    const json: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "j", toolName: "t", output: { type: "json", value: { a: "z".repeat(2000) } } }] };
    const kept = compactHistory([user("a"), call("j"), json, reply("A"), user("b"), reply("B")], 8);
    const part = (kept[2] as { content: { output: { type: string; value: string } }[] }).content[0]!.output;
    expect(part.type).toBe("text");
    expect(part.value.length).toBe(OLD_TOOL_CHARS + 1);
    expect(toolTexts(compactHistory([user("a"), call("1"), result("1", "court"), reply("A"), user("b"), reply("B")], 8))).toEqual(["court"]);
  });
});
