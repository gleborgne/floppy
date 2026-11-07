// Adaptateur Hermes Agent : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "hermes", label: "Hermes Agent", program: "hermes", aliases: ["hermes","hermès","hermes agent"],
  protocol: "hermes",
  args: (prompt, model) => ["chat", ...(model ? ["--model", model] : []), "--query", prompt],
});
