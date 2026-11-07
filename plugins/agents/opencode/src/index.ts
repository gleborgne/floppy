// Adaptateur OpenCode : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "opencode", label: "OpenCode", program: "opencode", aliases: ["opencode","open code"],
  protocol: "opencode",
  args: (prompt, model) => [...(model ? ["--model", model] : []), "--prompt", prompt],
});
