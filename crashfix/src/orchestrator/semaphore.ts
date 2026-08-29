export class Semaphore {
  private q: (() => void)[] = [];
  private avail: number;
  inFlight = 0;

  constructor(permits: number) {
    this.avail = Math.max(1, permits);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.avail <= 0) await new Promise<void>((res) => this.q.push(res));
    this.avail--; this.inFlight++;
    try {
      return await fn();
    } finally {
      this.avail++; this.inFlight--;
      this.q.shift()?.();
    }
  }
}
