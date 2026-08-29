export class Semaphore {
  private q: (() => void)[] = [];
  private avail: number;
  #inFlight = 0;

  constructor(permits: number) {
    this.avail = Math.max(1, permits);
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // while, not if: a waiter woken by q.shift() must re-check — a synchronous
    // run() can steal the freed permit before this microtask resumes.
    while (this.avail <= 0) await new Promise<void>((res) => this.q.push(res));
    this.avail--; this.#inFlight++;
    try {
      return await fn();
    } finally {
      this.avail++; this.#inFlight--;
      this.q.shift()?.();
    }
  }
}
