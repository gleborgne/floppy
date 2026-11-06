// Faux CLI Claude pour l'appel ponctuel (`-p`, JSON final) : le scénario dépend du texte reçu sur l'entrée standard.
const argv = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  const reply = (result, extra = {}) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra }));
  if (prompt.includes("ARGS")) return reply(JSON.stringify(argv));
  if (prompt.includes("FENCE")) return reply('Voilà :\n```json\n{"a":1}\n```\nBonne journée.');
  if (prompt.includes("RETRY")) return reply(prompt.includes("précédente") ? '{"ok":true}' : "désolé, pas de JSON");
  if (prompt.includes("NOJSON")) return reply("toujours pas de JSON");
  if (prompt.includes("ERREUR")) return reply("quota dépassé", { is_error: true });
  if (prompt.includes("CRASH")) { process.stderr.write("boum\n"); process.exit(3); }
  if (prompt.includes("LENT")) return setTimeout(() => {}, 60_000);
  reply(`ok:${prompt}`);
});
