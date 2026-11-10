// Ponts exposés aux pages par les preloads (src/preload*.cts, contextBridge.exposeInMainWorld) : une seule description,
// lue par les preloads (qui l'implémentent) et par les fenêtres (qui l'appellent). Fichier de types seulement : rien n'est émis.
// Les formes des données venues du noyau sont décrites à côté des fenêtres qui les lisent (types-*.d.ts).

/** Retire l'abonnement fait par un `on…`. */
type Unsubscribe = () => void;

interface FloppyHostApi {
  setState(state: string): void;
  activity(kind?: string): void;
  approvalClosed(): void;
  openSettings(): void;
  /** Déplacer l'avatar (outil vocal) : renvoie { ok, text: { fr, en } }. */
  place(a: { corner?: string; screen?: unknown; target?: string }): Promise<{ ok: boolean; text: { fr: string; en: string } }>;
  dictationLevel(v: number): void;
  dictation(d: { del?: number; ins?: string }): void;
  openPanel(p: { id?: string; title?: string; a2ui?: unknown[] }): void;
  openDocument(d: { id?: string; title?: string; markdown?: string; entries?: unknown[] }): void;
  updateDocuments(entries: unknown[]): void;
  /** Relaie à la fenêtre « Conversation » un message du noyau (types connus seulement, relus par le preload). */
  chat(m: { type: string; [key: string]: unknown }): void;
  openChat(): void;
  setInteractive(on: boolean): void;
  drag(phase: "start" | "move" | "end"): void;
}

interface FloppySettingsApi {
  get(): Promise<SettingsSnapshot>;
  set(key: string, value: unknown): Promise<SettingsReply | undefined>;
  undo(): Promise<SettingsReply | undefined>;
  items(): Promise<ItemsSnapshot>;
  openOnboarding(): void;
  onboardingState(): Promise<OnboardingState | null>;
  onOnboarding(cb: (state: OnboardingState) => void): Unsubscribe;
  itemOp(op: ItemOp): Promise<ItemOpResult>;
  pickPath(opts?: { directory?: boolean; filters?: unknown[] }): Promise<string | null>;
  onItems(cb: (data: ItemsSnapshot) => void): Unsubscribe;
  onFocus(cb: (target: SettingsFocusTarget) => void): Unsubscribe;
  onUpdate(cb: (data: SettingsSnapshot) => void): Unsubscribe;
}

interface FloppyCoderApi {
  agents(): Promise<CoderAgent[] | null>;
  start(agent: string, mode: string): Promise<CoderStart | null>;
  send(id: string, text: string): void;
  cancel(id: string): void;
  answer(id: string, permissionId: string, allow: boolean): void;
  close(id: string): void;
  onEvent(cb: (ev: CoderEvent) => void): Unsubscribe;
}

interface FloppyDocsApi {
  onShow(cb: (data: DocsShow) => void): Unsubscribe;
  onList(cb: (entries: DocEntry[]) => void): Unsubscribe;
  onLang(cb: (lang: string) => void): Unsubscribe;
  select(id: string): void;
  remove(id: string, current?: string): void;
  link(url: string): void;
}

interface FloppyPanelApi {
  onShow(cb: (data: PanelShow) => void): Unsubscribe;
  action(name: string, context?: Record<string, unknown>): void;
}

interface FloppyOnboardingApi {
  plan(opts?: { fresh?: boolean; manualBytes?: number }): Promise<OnboardingReply<OnboardingPlan>>;
  /** Change la langue de l'assistant (comme les Réglages) et rend le plan recalculé. */
  setLanguage(lang: string, opts?: { manualBytes?: number }): Promise<OnboardingReply<OnboardingPlan>>;
  /** Lance en avance le téléchargement de l'écoute (sans effet la seconde fois). */
  prepareListening(): Promise<OnboardingReply>;
  /** Façons d'appeler Floppy et connecteurs que la fenêtre peut allumer. */
  extras(): Promise<OnboardingReply<OnboardingExtras>>;
  /** Mot d'activation (`wake`) ou raccourci « Parler » (`talk`) : même chemin que les Réglages. */
  setWay(way: "wake" | "talk", value: string): Promise<OnboardingReply>;
  /** Allume ou éteint un connecteur. */
  setTool(id: string, on: boolean): Promise<OnboardingReply>;
  apply(selection: OnboardingSelection): Promise<OnboardingReply>;
  skip(): Promise<OnboardingReply>;
  chooseHome(): Promise<OnboardingReply>;
  close(): void;
  openSettings(): void;
  onState(cb: (state: OnboardingState) => void): Unsubscribe;
}

interface FloppyChatApi {
  /** Le texte part vers Floppy par l'avatar ; faux si Floppy n'est pas prêt (le brouillon reste). */
  submit(text: string): Promise<boolean>;
  close(): void;
  answerApproval(id: string, ok: boolean): void;
  answerChoice(id: string, option: string): void;
  link(url: string): void;
  onInit(cb: (data: ChatInit) => void): Unsubscribe;
  onChange(cb: (delta: ChatDelta) => void): Unsubscribe;
  onLang(cb: (lang: string) => void): Unsubscribe;
  onFocus(cb: () => void): Unsubscribe;
}

interface FloppyDictationApi {
  onLevel(cb: (level: number) => void): void;
  onTyped(cb: () => void): void;
  onState(cb: (state: string) => void): void;
  onLang(cb: (lang: string) => void): void;
  stop(): void;
}

/** Icônes Lucide (icons.ts, script classique chargé avant les modules). */
interface Window {
  floppyDesktop?: FloppyDesktopApi;
  floppyHost?: FloppyHostApi;
  floppySettings?: FloppySettingsApi;
  floppyCoder?: FloppyCoderApi;
  floppyDocs: FloppyDocsApi;
  floppyPanel: FloppyPanelApi;
  floppyOnboarding: FloppyOnboardingApi;
  floppyChat: FloppyChatApi;
  floppyDictation: FloppyDictationApi;
  lucideIcon?: (name: string) => SVGSVGElement;
  lucideIconPaths?: (name: string) => string[];
}
