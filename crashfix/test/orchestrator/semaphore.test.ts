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

  it('a burst of synchronous run() calls never exceeds `permits` concurrency', async () => {
    const sem = new Semaphore(3);
    let peak = 0, running = 0;
    // Fire all 50 synchronously in one tick — exercises the wake/steal window
    // where an `if` (not `while`) permit check over-permits by one.
    const tasks = Array.from({ length: 50 }, () =>
      sem.run(async () => {
        running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('inFlight is readable and reflects running count', async () => {
    const sem = new Semaphore(2);
    expect(sem.inFlight).toBe(0);
    const task = sem.run(async () => {
      expect(sem.inFlight).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(sem.inFlight).toBe(1);
    await task;
    expect(sem.inFlight).toBe(0);
  });
});
