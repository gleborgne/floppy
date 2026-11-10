// Formes du journal de la fenêtre « Conversation » (calculé par le processus principal, voir src/chat-log.ts).
interface ChatOption { id: string; label: string; detail?: string }
type ChatEntry =
  | { id: number; kind: "you"; text: string }
  | { id: number; kind: "reply"; text: string; html: string; done: boolean }
  | { id: number; kind: "info"; title: string; text: string; important: boolean }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "approval"; key: string; summary: string; ttl_s: number; at: number; outcome: "pending" | "yes" | "no" }
  | { id: number; kind: "choice"; key: string; title: string; options: ChatOption[]; ttl_s: number; at: number; closed: boolean; picked: string };
/** Ce qui change : entrées créées ou modifiées (par id) et entrées parties. */
interface ChatDelta { changed: ChatEntry[]; removed: number[] }
interface ChatInit { lang: string; entries: ChatEntry[]; /** État de Floppy au chargement (« listening » : il écoute). */ state?: string }
