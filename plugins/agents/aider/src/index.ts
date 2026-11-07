// Adaptateur Aider : le protocole et le cycle de vie communs vivent dans @floppy/agent-cli.
import { createExternalAgent } from "@floppy/agent-cli";
import { writeFileAtomic } from "@floppy/core";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export default createExternalAgent({
  id: "aider", label: "Aider", program: "aider", aliases: ["aider"],
  args: (prompt, model, workspace) => {
    const file = join(workspace, `${randomUUID()}.txt`);
    writeFileAtomic(file, `/code ${prompt.replace(/[\r\n]/g, " ")}\n`);
    return [...(model ? ["--model", model] : []), "--load", file];
  },
});
