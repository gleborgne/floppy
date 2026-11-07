// Adaptateur Oh My Pi : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
export default createExternalAgent({
  id: "omp", label: "Oh My Pi", program: "omp", aliases: ["oh my pi","omp","oh-my-pi"],
  protocol: "omp",
  args: (prompt, model) => [...(model ? ["--model", model] : []), prompt],
});
