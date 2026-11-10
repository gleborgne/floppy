// Recherche de modèles GGUF sur Hugging Face (comme LM Studio) : dépôts publics, quelques quantifications par dépôt.
// Chaque fichier proposé est figé au commit lu (adresse /resolve/<commit>/) et vérifié par son empreinte sha256 (Git LFS).
import { T, type DownloadFile, type ModelNeeds, type Text } from "@floppy/core";
import type { LibraryEntry } from "@floppy/setup";

const API = "https://huggingface.co/api/models";

/** Quantifications proposées, dans l'ordre de préférence (bon compromis d'abord). */
const PREFERRED = ["Q4_K_M", "Q4_0", "Q5_K_M", "Q6_K", "Q8_0", "IQ4_XS", "Q3_K_M"];
/** Nombre de dépôts lus, et de fichiers proposés par dépôt. */
const REPOS = 8;
const PER_REPO = 3;

/** « ≈ 6 Go de mémoire » : le fichier + le contexte et les tampons (estimation grossière, comme le bouton Essayer). */
export function memoryTag(bytes: number): Text {
  const gb = Math.ceil(bytes / 1e9 + 1.2);
  return T(`≈ ${gb} Go de mémoire`, `≈ ${gb} GB of memory`);
}

/** Ce que demande un modèle GGUF : le fichier + ~1,2 Go (contexte 32k, tampons), sur la puce graphique (tous moteurs). */
export function ggufNeeds(bytes: number): ModelNeeds {
  return { memory: bytes + 1.2e9, device: "gpu" };
}

/** Quantification lue dans le nom (« Q4_K_M »), ou undefined. */
export function quantOf(file: string): string | undefined {
  const name = file.replace(/^.*\//, "").replace(/(-\d{5}-of-\d{5})?\.gguf$/i, "");
  // La dernière étiquette qui ressemble à une quantification (« gemma-4-E4B_q4_0-it » -> Q4_0).
  const all = [...name.matchAll(/(?:^|[-_.])(I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=$|[-.])/gi)];
  return all.at(-1)?.[1]?.toUpperCase();
}

interface TreeFile { type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } }
interface RepoInfo { id: string; sha?: string; gated?: unknown; private?: boolean; cardData?: { license?: string } }

/** Fichiers GGUF d'un dépôt, regroupés (un modèle coupé en plusieurs fichiers « -00001-of-00003 » = une entrée). */
export function ggufGroups(files: TreeFile[]): { name: string; parts: TreeFile[] }[] {
  const groups = new Map<string, TreeFile[]>();
  for (const f of files) {
    if (f.type !== "file" || !/\.gguf$/i.test(f.path) || /mmproj/i.test(f.path)) continue;
    const key = f.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, ".gguf");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return [...groups].map(([name, parts]) => ({ name, parts: parts.sort((a, b) => a.path.localeCompare(b.path)) }));
}

/** Les fichiers à proposer : quantifications préférées d'abord, au plus PER_REPO. */
export function pickGroups<G extends { name: string }>(groups: G[]): G[] {
  const rank = (g: G) => { const q = quantOf(g.name); const i = q ? PREFERRED.indexOf(q) : -1; return i < 0 ? 99 : i; };
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, PER_REPO);
}

/** Cherche des modèles GGUF publics. Les dépôts protégés (accord à signer) ou sans empreinte sont ignorés. */
export async function searchHf(query: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response>): Promise<LibraryEntry[]> {
  const get = async <R>(url: string): Promise<R> => {
    const r = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Hugging Face a répondu ${r.status}`);
    return (await r.json()) as R;
  };
  const list = await get<{ id: string }[]>(`${API}?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=${REPOS}`);
  const repos = await Promise.all(list.slice(0, REPOS).map(async ({ id }) => {
    try {
      const [info, tree] = await Promise.all([get<RepoInfo>(`${API}/${id}`), get<TreeFile[]>(`${API}/${id}/tree/main?recursive=true`)]);
      return { info, tree };
    } catch { return undefined; } // un dépôt illisible ne casse pas la recherche
  }));
  const out: LibraryEntry[] = [];
  for (const r of repos) {
    if (!r || !r.info.sha || r.info.private || (r.info.gated && r.info.gated !== false)) continue;
    const { id, sha } = r.info;
    const licence = r.info.cardData?.license;
    for (const g of pickGroups(ggufGroups(r.tree))) {
      if (!g.parts.every((p) => p.lfs?.oid)) continue;
      const files: DownloadFile[] = g.parts.map((p) => ({
        url: `https://huggingface.co/${id}/resolve/${sha}/${p.path.split("/").map(encodeURIComponent).join("/")}`,
        path: `hf/${id}/${p.path}`, size: p.lfs?.size ?? p.size ?? 0, sha256: p.lfs!.oid!,
      }));
      const size = files.reduce((n, f) => n + (f.size ?? 0), 0);
      const name = id.slice(id.indexOf("/") + 1).replace(/[-_]GGUF$/i, "");
      const q = quantOf(g.name);
      out.push({
        id: `hf/${id}/${g.name}`,
        label: q ? `${name} · ${q}` : name,
        description: g.parts.length > 1 ? T(`${id} · ${g.parts.length} fichiers`, `${id} · ${g.parts.length} files`) : id,
        ...(licence ? { licence: { name: licence, url: `https://huggingface.co/${id}` } } : {}),
        tags: [memoryTag(size)],
        needs: ggufNeeds(size),
        files,
      });
    }
  }
  return out;
}
