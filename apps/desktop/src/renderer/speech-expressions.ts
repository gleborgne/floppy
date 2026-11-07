/** Expressions attachées à l'horloge audio locale, jamais au temps de génération du son. */
export interface SpeechExpression { emotion: string; intensity?: number; ms?: number }
export class SpeechExpressions<T = SpeechExpression> {
  private pending?: T;
  private scheduled: { at: number; expression: T }[] = [];
  mark(expression: T): void { this.pending = expression; }
  audio(at: number): void {
    if (this.pending) this.scheduled.push({ at, expression: this.pending });
    this.pending = undefined;
  }
  tick(now: number, show: (expression: T, at: number) => void): void {
    // Une fenêtre momentanément suspendue reprend avec la dernière expression audible.
    let latest: { at: number; expression: T } | undefined;
    while (this.scheduled[0] && this.scheduled[0].at <= now) latest = this.scheduled.shift()!;
    if (latest) show(latest.expression, latest.at);
  }
  clear(): void { this.pending = undefined; this.scheduled = []; }
}
