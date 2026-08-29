import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/orchestrator/semaphore.js';

describe('Semaphore', () => {
  it('never runs more than `permits` tasks at once', async () => {
    const sem = new Semaphore(2);
    let peak = 0, running = 0;
    const task = () => sem.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});
