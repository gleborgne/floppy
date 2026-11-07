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
  place(a: { coin?: string; ecran?: unknown; cible?: string }): Promise<{ ok: boolean; text: { fr: string; en: string } }>;
  dictationLevel(v: number): void;
  dictation(d: { del?: number; ins?: string }): void;
  openPanel(p: { id?: string; title?: string; a2ui?: unknown[] }): void;
  openDocument(d: { id?: string; titre?: string; markdown?: string; liste?: unknown[] }): void;
  updateDocuments(liste: unknown[]): void;
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
  onList(cb: (liste: DocEntry[]) => void): Unsubscribe;
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
  apply(level: string, brain?: string | null): Promise<OnboardingReply>;
  skip(): Promise<OnboardingReply>;
  chooseHome(): Promise<OnboardingReply>;
  close(): void;
  openSettings(): void;
  onState(cb: (state: OnboardingState) => void): Unsubscribe;
}

interface FloppyTextApi {
  submit(text: string): Promise<boolean>;
  close(): void;
  onLang(cb: (lang: string) => void): void;
  onFocus(cb: () => void): void;
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
  floppyHost?: FloppyHostApi;
  floppySettings?: FloppySettingsApi;
  floppyCoder?: FloppyCoderApi;
  floppyDocs: FloppyDocsApi;
  floppyPanel: FloppyPanelApi;
  floppyOnboarding: FloppyOnboardingApi;
  floppyText: FloppyTextApi;
  floppyDictation: FloppyDictationApi;
  lucideIcon?: (name: string) => SVGSVGElement;
  lucideIconPaths?: (name: string) => string[];
}
