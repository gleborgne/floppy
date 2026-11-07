// Adaptateur GitHub Copilot : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "copilot", label: "GitHub Copilot", program: "copilot", aliases: ["copilot","github copilot"],
  args: (prompt, model) => [...(model ? ["--model", model] : []), "--interactive", prompt],
});
