/** Contributions intégrées de confiance : page locale, menus et lectures nommées.
 * Propriétaire/jeton écartent les activations périmées, sans isoler les plugins du même processus.
 * Le SDK tiers n'expose pas ctx.host. L'inscription (`registerDesktop`) vit dans @floppy/toolkit.
 */
export interface DesktopContribution {
  id: string;
  title: { fr: string; en: string };
  menus: ("tray" | "avatar")[];
  order?: number;
  view?: { page: string };
}
export interface DesktopRegistration extends DesktopContribution {
  owner: string;
  token: string;
  actions: string[];
}
export interface DesktopContent {
  snapshot?(): unknown;
  subscribe?(publish: () => void): () => void;
  /** Lectures uniquement ; aucun argument libre ni passerelle vers les outils. */
  actions?: Record<string, (signal: AbortSignal) => unknown | Promise<unknown>>;
}
