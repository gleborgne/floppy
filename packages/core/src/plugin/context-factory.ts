// Fabrique du `ctx` d'un plugin : tout ce qu'un plugin fait passe par lui (services, effets, réglages, éléments,
// programmes, réseau, accords). Le noyau l'appelle au démarrage d'une entrée ; la fabrique lit le noyau par sa vue
// interne (kernel-internals.ts), sans élargir son API publique.
import { spawn as nodeSpawn, execFile, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Entry } from "./kernel.ts";
import type { KernelInternals } from "./kernel-internals.ts";
import { EffectScope } from "./effects.ts";
import { execAllowed, programName, type PluginDef } from "./manifest.ts";
import type { Context, ContextApprovals, HostChannel, HostMessage } from "./context.ts";
import { ItemStore } from "../catalog.ts";
import { cleanLogo } from "../logo.ts";
import { scopedSecrets } from "../secrets.ts";
import { T, TextError, tr, type Text } from "../i18n.ts";
import { downloadsDir, hostAllowed } from "../downloads.ts";
import { killTree } from "../util/process.ts";
import { KERNEL_EVENTS, offerItems } from "./lifecycle-util.ts";


/** Canal de l'hôte pour un plugin : ses écouteurs tournent à son nom et sont retirés à son arrêt. */
export function hostFor(k: KernelInternals, id: string, scope: EffectScope, as: <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A) => R): HostChannel {
  const host = k.host!;
  const off = (fn: (e: HostMessage) => void) => { (host.off ?? host.removeListener)?.call(host, "message", fn); };
  const wrapped = new Map<(e: HostMessage) => void, (e: HostMessage) => void>();
  return {
    postMessage: (data) => { if (!scope.isClosed) host.postMessage(data); else k.log("warn", id, "host.postMessage après l'arrêt du plugin : refusé"); },
    on: (_ev, fn) => {
      const w = as(fn);
      wrapped.set(fn, w);
      host.on("message", w);
      scope.add(() => off(w));
    },
    off: (_ev, fn) => { const w = wrapped.get(fn); if (w) { off(w); wrapped.delete(fn); } },
  };
}

/**
 * Vue des accords pour un plugin : demander pour tous, répondre / lister seulement avec permissions.approvals.
 * Les demandes d'un plugin qui s'arrête sont annulées ; un plugin arrêté ne peut plus en ouvrir.
 */
export function approvalsFor(k: KernelInternals, manifest: PluginDef["manifest"], id: string, scope: EffectScope): ContextApprovals {
  const may = manifest.permissions?.approvals === "respond";
  const deny = (what: string): never => { throw new Error(`${id} : ${what} demande permissions.approvals: "respond" dans le manifeste (seuls les corps et la CLI répondent aux accords)`); };
  const stop = new AbortController();
  scope.add(() => stop.abort());
  return {
    check: (input) => {
      if (scope.isClosed) return Promise.resolve({ ok: false, reason: "cancelled" as const });
      return k.approvals.check({ ...input, signal: input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal });
    },
    respond: (rid, ok, by) => may ? k.approvals.respond(rid, ok, by) : deny("approvals.respond"),
    pending: () => may ? k.approvals.pending() : deny("approvals.pending"),
  };
}

export function makeContext(k: KernelInternals, e: Entry, scope: EffectScope, pending: Map<string, unknown>): Context {
  const def = e.def!;
  const allowed = new Set(e.fork ? [] : [...(def.manifest.inject ?? []), ...(def.manifest.optional ?? [])]);
  const kernel = k;
  let noteOff = false;
  let logoOff = false;
  /** Un plugin arrêté ne fait plus rien par le noyau (du code à lui peut encore tourner : il est refusé et signalé). */
  const warned = new Set<string>();
  const closed = (what: string): boolean => {
    if (!scope.isClosed) return false;
    if (!warned.has(what)) { warned.add(what); kernel.log("warn", e.cfg.id, `${what} après l'arrêt du plugin : refusé`); }
    return true;
  };
  const stoppedError = () => new TextError(T(`${e.cfg.id} est arrêté`, `${e.cfg.id} is stopped`));
  /** Code du plugin appelé par le noyau (écouteur, minuterie, outil) : il tourne au nom de l'entrée (filet global). */
  const as = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => kernel.als.run(e.cfg.id, () => fn(...a));
  /** Minuterie du plugin : une erreur est notée à son nom, sans casser le noyau. */
  const guarded = (fn: () => unknown, what: string) => as(() => {
    const report = (err: unknown) => kernel.log("error", e.cfg.id, `${what} : ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, report);
    } catch (err) { report(err); }
  });
  const read = (name: string): unknown => {
    if (!allowed.has(name) && !e.used.has(name)) throw new Error(`${e.cfg.id} : service ${name} non déclaré dans inject/optional`);
    const p = e.bound.get(name);
    return p ? kernel.entries.get(p)?.provided.get(name) : undefined;
  };
  /** Prête un fork (dans la file du noyau) : démarré si besoin, gardé jusqu'à release(), rendu à l'arrêt du plugin. */
  const lend = async (key: string, service: string): Promise<never | undefined> => {
    kernel.hold(key, 1);
    const f = await kernel.ensureFork(key);
    const svc = f?.provided.get(service);
    if (!svc) { kernel.hold(key, -1); await kernel.reconcile(); return undefined; }
    let done = false;
    let markLost!: () => void;
    const lost = new Promise<void>((r) => { markLost = r; });
    const set = kernel.borrowers.get(key) ?? new Set<() => void>();
    kernel.borrowers.set(key, set);
    set.add(markLost);
    const release = () => {
      if (done) return;
      done = true;
      set.delete(markLost);
      kernel.hold(key, -1);
      void kernel.enqueue(() => kernel.reconcile()).catch(() => {});
    };
    // Le fork s'arrête pendant l'emprunt : l'emprunteur le sait (lost), et la place est rendue.
    void lost.then(release);
    scope.add(release); // le plugin s'arrête : il rend ce qu'il a emprunté
    return { service: svc, release, lost } as never;
  };
  return {
    id: e.cfg.id,
    plugin: e.cfg.plugin,
    assistant: k.assistant,
    uiLang: () => k.uiLang,
    machine: () => k.machine(),
    restartOffers: (service) => k.restartForks(e.fork?.parent ?? e.cfg.id, service),
    approvals: approvalsFor(k, def.manifest, e.cfg.id, scope),
    audit: k.audit,
    home: k.home,
    workspace: (name) => {
      const safe = (s: string) => s.replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "_");
      const dir = join(k.home, "workspaces", safe(def.manifest.id), ...(name ? [safe(name)] : []));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    settings: {
      declare: (defs) => { const off = k.settings.declare(e.cfg.id, defs); scope.add(off); return off; },
      saved: (key) => k.settings.savedValue(key),
      savedEntries: (prefix) => k.settings.savedEntries(prefix),
      value: (key) => k.settings.value(key),
      list: () => k.settings.list(),
      change: (key, value, origin) => closed("settings.change") ? Promise.reject(stoppedError()) : k.settings.change(key, value, "voice", origin),
    },
    items: {
      declare: (def) => { scope.add(k.items.declare(e.cfg.id, def)); },
      changed: () => k.items.changed(),
      store: (name) => ItemStore.in(k.home, name ?? e.cfg.id),
      snapshot: () => k.items.snapshot(),
      // Un plugin ne peut pas se faire passer pour la fenêtre (« ui ») ou la CLI : tout sauf « voice » devient « assistant ».
      run: (op, via) => closed("items.run") ? Promise.reject(stoppedError()) : k.items.run(op, via === "voice" ? "voice" : "assistant"),
      actions: (list, run) => {
        k.appActions.set(e.cfg.id, { list, run });
        scope.add(() => { if (k.appActions.get(e.cfg.id)?.run === run) k.appActions.delete(e.cfg.id); });
        k.items.changed();
      },
      status: (text, tone) => {
        k.notes.set(e.cfg.id, { text, ...(tone ? { tone } : {}) });
        if (!noteOff) { noteOff = true; scope.add(() => { k.notes.delete(e.cfg.id); k.items.changed(); }); }
        k.items.changed();
      },
      logo: (logo) => {
        if (logo === undefined) k.logos.delete(e.cfg.id);
        else k.logos.set(e.cfg.id, cleanLogo(logo) ?? null);
        if (!logoOff) { logoOff = true; scope.add(() => { k.logos.delete(e.cfg.id); k.items.changed(); }); }
        k.items.changed();
      },
    },
    secrets: scopedSecrets(k.secrets, def.manifest.id),
    downloads: {
      get dir() { return downloadsDir(kernel.modelsDir, e.cfg.id); },
      start: (req) => {
        if (closed("downloads.start")) throw stoppedError();
        const s = k.downloads.start(`${e.cfg.id}/${req.key}`, req, downloadsDir(k.modelsDir, e.cfg.id), def.manifest.permissions?.net);
        return { ...s, key: req.key };
      },
      get: (key) => { const s = k.downloads.get(`${e.cfg.id}/${key}`); return s && { ...s, key }; },
      cancel: (key) => k.downloads.cancel(`${e.cfg.id}/${key}`),
      onChange: (fn) => {
        const prefix = `${e.cfg.id}/`;
        scope.add(k.downloads.onChange((s) => { if (s.key.startsWith(prefix)) fn({ ...s, key: s.key.slice(prefix.length) }); }));
      },
    },
    tools: {
      register: (defs) => {
        const clean = defs.map(({ selfApproved: _s, ...d }) => ({ ...d, handler: as(d.handler) }));
        const remove = scope.add(k.tools.register(e.cfg.id, clean));
        return () => { void remove(); };
      },
      list: () => k.tools.list(),
      call: (name, args, meta) => closed("tools.call") ? Promise.reject(stoppedError()) : k.tools.call(name, args, meta),
      onChange: (fn) => { scope.add(k.tools.onChange(fn)); },
    },
    get alive() { return !scope.isClosed; },
    ...(e.fork ? { item: e.fork.item } : {}),
    provide(name, impl) {
      if (!(def.manifest.provides ?? []).includes(name)) throw new Error(`${e.cfg.id} : service ${name} non déclaré dans provides`);
      if (e.fork && name !== e.fork.service) throw new Error(`${e.cfg.id} : ce fork fournit seulement ${e.fork.service}`);
      if (!e.fork && e.offers.has(name)) throw new Error(`${e.cfg.id} : ${name} est déjà offert élément par élément (ctx.offer)`);
      if (e.state !== "starting" || scope.isClosed) throw new Error(`${e.cfg.id} : ctx.provide(${name}) après la fin de apply (les services se fournissent pendant apply)`);
      pending.set(name, impl);
    },
    get(name) {
      const v = read(name);
      if (v === undefined) throw new Error(`${e.cfg.id} : service ${name} absent`);
      return v as never;
    },
    maybe(name) { return read(name) as never; },
    async use(name) {
      if (e.state !== "starting" || scope.isClosed) throw new Error(`${e.cfg.id} : ctx.use(${name}) se fait pendant apply`);
      // Un fork peut demander tout service ; une entrée seulement ceux de son manifeste (transparence des besoins).
      if (!e.fork && !allowed.has(name)) throw new Error(`${e.cfg.id} : service ${name} non déclaré dans inject/optional`);
      e.used.add(name);
      // Le temps passé à démarrer un autre plugin ne compte pas dans le délai de celui-ci.
      const deadline = e.deadline;
      deadline?.pause();
      try {
        const x = await kernel.ensureActive(kernel.candidateOf(name));
        // Démarrage abandonné entre-temps (ctx.fail, délai, arrêt) : ce contexte est fermé, il ne lie plus rien.
        // Le service a pu démarrer pour rien : le noyau revoit l'état (il l'arrête s'il ne sert à personne).
        if (scope.isClosed) { void kernel.enqueue(() => kernel.reconcile()).catch(() => {}); return undefined as never; }
        e.bound.set(name, x?.cfg.id);
        return x?.provided.get(name) as never;
      } finally { deadline?.resume(); }
    },
    async slot(id) {
      if (e.state !== "starting" || scope.isClosed) throw new Error(`${e.cfg.id} : ctx.slot(${id}) se fait pendant apply`);
      if (!(def.manifest.slots ?? []).some((x) => x.id === id)) throw new Error(`${e.cfg.id} : slot ${id} non déclaré dans le manifeste`);
      const key = kernel.slotKey(id);
      e.slotBound.set(id, key);
      const deadline = e.deadline;
      deadline?.pause();
      try {
        const f = key ? await kernel.ensureFork(key) : undefined;
        if (scope.isClosed) { void kernel.enqueue(() => kernel.reconcile()).catch(() => {}); return undefined as never; }
        return f?.provided.get(kernel.slotDefs.get(id)!.def.service) as never;
      } finally { deadline?.resume(); }
    },
    offers(service) {
      if (!allowed.has(service)) throw new Error(`${e.cfg.id} : service ${service} non déclaré dans inject/optional`);
      const out: { value: string; label: Text; cloud?: boolean; entry: string }[] = [];
      for (const x of kernel.entries.values()) {
        const offer = x.state === "active" ? x.offers.get(service) : undefined;
        if (offer) for (const i of offerItems(offer)) out.push({ value: `${x.cfg.id}/${i.id}`, label: i.label, entry: x.cfg.id, ...(i.cloud ? { cloud: true } : {}) });
      }
      return out;
    },
    borrowItem(service, value) {
      if (!allowed.has(service)) throw new Error(`${e.cfg.id} : service ${service} non déclaré dans inject/optional`);
      if (e.state === "starting") throw new Error(`${e.cfg.id} : ctx.borrowItem se fait après apply`);
      const cut = value.indexOf("/");
      if (cut < 1) return Promise.resolve(undefined);
      const entry = value.slice(0, cut);
      const item = value.slice(cut + 1);
      return kernel.enqueue(async () => {
        const p = kernel.entries.get(entry);
        const offer = p?.state === "active" ? p.offers.get(service) : undefined;
        if (scope.isClosed || !offer || !offerItems(offer).some((i) => i.id === item)) return undefined;
        return lend(`${entry}/${service}/${item}`, service);
      });
    },
    borrow(id) {
      if (!(def.manifest.slots ?? []).some((x) => x.id === id)) throw new Error(`${e.cfg.id} : slot ${id} non déclaré dans le manifeste`);
      if (e.state === "starting") throw new Error(`${e.cfg.id} : ctx.borrow(${id}) se fait après apply (pendant apply : ctx.slot)`);
      return kernel.enqueue(async () => {
        if (scope.isClosed) return undefined;
        const key = kernel.slotKey(id);
        if (!key) return undefined;
        return lend(key, kernel.slotDefs.get(id)!.def.service);
      });
    },
    tasks: {
      list: () => kernel.tasks.list(),
      run: (key, raison) => closed("tasks.run") ? Promise.reject(stoppedError()) : kernel.tasks.run(key, raison ?? "manuel"),
      onChange: (fn) => { scope.add(kernel.tasks.onChange(fn)); },
    },
    offer(service, od) {
      if (e.fork) throw new Error(`${e.cfg.id} : un fork ne peut pas offrir`);
      if (!(def.manifest.provides ?? []).includes(service)) throw new Error(`${e.cfg.id} : service ${service} non déclaré dans provides`);
      if (e.offers.has(service) || pending.has(service)) throw new Error(`${e.cfg.id} : ${service} déjà fourni ou offert`);
      e.offers.set(service, od);
      scope.add(() => { if (e.offers.get(service) === od) e.offers.delete(service); });
    },
    selectedProvider(name) {
      read(name); // vérifie inject / optional
      const selected = kernel.selectedProvider(name);
      return selected === "@none" ? undefined : selected;
    },
    effect: (dispose) => scope.add(dispose),
    on: (event, fn) => { scope.add(k.bus.on(event, as(fn))); },
    ...(k.host ? { host: hostFor(k, e.cfg.id, scope, as) } : {}),
    emit: (event, payload) => {
      if (closed(`emit(${event})`)) return;
      // Ces événements disent ce que le noyau a décidé : un plugin ne peut pas les imiter (fausse demande d'accord…).
      if (KERNEL_EVENTS.has(event)) {
        if (!warned.has(`kernel-event:${event}`)) { warned.add(`kernel-event:${event}`); k.log("warn", e.cfg.id, `emit(${event}) refusé : événement réservé au noyau`); }
        return;
      }
      k.bus.emit(event, payload);
    },
    fetch: (url, init = {}) => {
      if (closed("fetch")) return Promise.reject(stoppedError());
      const { timeoutMs, ...rest } = init;
      let host = "";
      try { host = new URL(String(url)).hostname; } catch { /* adresse invalide : fetch le dira */ }
      if (host && !hostAllowed(def.manifest.permissions?.net, host) && !warned.has(`net:${host}`)) {
        warned.add(`net:${host}`);
        k.log("warn", e.cfg.id, `réseau : ${host} n'est pas dans permissions.net (avertissement : la requête part quand même)`);
      }
      const limit = AbortSignal.timeout(timeoutMs ?? 30_000);
      return fetch(url, { ...rest, signal: rest.signal ? AbortSignal.any([rest.signal, limit]) : limit });
    },
    hook: (name, mw) => { scope.add(k.hooks.add(name, as(mw), e.cfg.id)); },
    runHook: (name, input, final) => closed(`runHook(${name})`) ? Promise.reject(stoppedError()) : k.hooks.run(name, input, final),
    spawn: (command: string, args: string[], options: SpawnOptions & { keep?: boolean } = {}) => {
      if (!execAllowed(def.manifest.permissions, command)) {
        throw new Error(`${e.cfg.id} : lancer « ${programName(command)} » demande permissions.exec dans le manifeste (exec: ["${programName(command)}"])`);
      }
      if (closed(`spawn(${programName(command)})`)) throw stoppedError();
      const { keep, ...opts } = options;
      if (keep) {
        // Lancé pour l'utilisateur (navigateur, terminal) : détaché, il reste ouvert après Floppy.
        const child = nodeSpawn(command, args, { detached: true, stdio: "ignore", ...opts });
        child.on("error", (err) => k.log("warn", e.cfg.id, `${programName(command)} : ${err.message}`));
        child.unref();
        return child;
      }
      const child = nodeSpawn(command, args, { windowsHide: true, detached: process.platform !== "win32", ...opts });
      const close = scope.add(() => killTree(child));
      k.children.track(child, command, e.cfg.id);
      // Programme fini tout seul : sa fermeture est retirée (un plugin qui lance un programme par demande ne grossit pas).
      child.once("exit", () => { void close(); });
      return child;
    },
    exec: (command, args, options = {}) => {
      if (!execAllowed(def.manifest.permissions, command)) {
        return Promise.reject(new Error(`${e.cfg.id} : lancer « ${programName(command)} » demande permissions.exec dans le manifeste (exec: ["${programName(command)}"])`));
      }
      if (closed(`exec(${programName(command)})`)) return Promise.reject(stoppedError());
      const timeoutMs = options.timeoutMs ?? 30_000;
      return new Promise((resolve, reject) => {
        let timedOut = false;
        // Délai : tout l'arbre du programme est arrêté (killTree), pas seulement le premier processus
        // (`cmd.exe /c az …` laisserait az tourner).
        const timer = setTimeout(() => { timedOut = true; void killTree(child, 1000); }, timeoutMs);
        timer.unref?.();
        const child = execFile(command, args, {
          maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true, encoding: "utf8",
          ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}),
          ...(options.verbatim ? { windowsVerbatimArguments: true } : {}), ...(options.signal ? { signal: options.signal } : {}),
        }, (err, stdout, stderr) => {
          clearTimeout(timer);
          void close();
          const code = typeof (err as { code?: unknown } | null)?.code === "number" ? (err as { code: number }).code : err ? -1 : 0;
          if (timedOut || (err && (!options.allowFailure || code === -1 || (err as { killed?: boolean }).killed))) {
            const why = timedOut ? `délai dépassé (${Math.round(timeoutMs / 1000)} s)` : String(stderr || err!.message).trim().slice(0, 500);
            reject(new Error(`${programName(command)} : ${why}`));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        });
        const close = scope.add(() => killTree(child));
      });
    },
    interval: (fn, ms) => { const t = setInterval(guarded(fn, "minuterie"), ms); scope.add(() => clearInterval(t)); },
    timeout: (fn, ms) => { const t = setTimeout(guarded(fn, "minuterie"), ms); scope.add(() => clearTimeout(t)); },
    fail: (e.fail = (reason) => {
      k.log("error", e.cfg.id, `panne : ${tr(reason, "fr")}`);
      if (e.state === "starting") {
        // Pendant apply : on ferme les effets ; startEntry cesse d'attendre apply et pose l'erreur (une seule fois).
        if (e.scope === scope) k.abortStart(e, reason);
        return;
      }
      void k.enqueue(async () => {
        if (e.scope !== scope) return; // déjà arrêté ou redémarré
        await k.stopEntry(e, "error");
        e.error = reason;
        k.emitState(e);
        k.scheduleRetry(e);
        await k.reconcile();
      });
    }),
    log: (level, msg, data) => k.log(level, e.cfg.id, msg, data),
  };
}
