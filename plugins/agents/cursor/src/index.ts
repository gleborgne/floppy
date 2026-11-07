// Adaptateur Cursor : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "cursor", label: "Cursor", program: "agent", aliases: ["cursor","cursor agent"],
  args: (prompt, model) => [...(model ? ["--model", model] : []), prompt],
});
