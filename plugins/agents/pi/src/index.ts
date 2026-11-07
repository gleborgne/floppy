// Adaptateur Pi : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "pi", label: "Pi", program: "pi", aliases: ["pi","pi agent"],
  protocol: "pi",
  args: (prompt, model) => [...(model ? ["--model", model] : []), prompt],
});
