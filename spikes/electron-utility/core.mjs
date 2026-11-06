import { spawnSync } from "node:child_process";
process.parentPort.once("message", async (e) => {
  const port = e.ports[0];
  const r = { node: process.versions.node, electron: process.versions.electron };
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE h USING fts5(texte); INSERT INTO h VALUES ('comment on déploie le front');");
    r.fts5 = db.prepare("SELECT count(*) AS n FROM h WHERE h MATCH 'déploie'").get().n === 1;
  } catch (err) { r.fts5 = String(err); }
  const c = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/c", "echo enfant-ok"], { encoding: "utf8" });
  r.spawn = c.stdout.trim() === "enfant-ok";
  r.ok = r.fts5 === true && r.spawn;
  port.postMessage(r);
});
