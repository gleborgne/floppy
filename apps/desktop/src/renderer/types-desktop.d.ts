interface DesktopPayload { snapshot: unknown; lang: string }
interface FloppyDesktopApi {
  get(): Promise<DesktopPayload | null>;
  action(name: string): Promise<unknown>;
  onUpdate(fn: (payload: DesktopPayload) => void): () => void;
}
