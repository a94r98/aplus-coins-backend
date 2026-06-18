import { redisClient } from '../config/redis';

export class LockService {
  private static localLocks = new Map<string, { expiresAt: number }>();

  /**
   * Acquires a lock on a key.
   * If lock is held, it will retry/wait up to maxWaitMs.
   */
  static async acquire(key: string, ttlMs = 5000, maxWaitMs = 10000): Promise<boolean> {
    const start = Date.now();
    
    while (true) {
      const now = Date.now();

      if (redisClient) {
        try {
          // Attempt to set key in Redis only if it doesn't exist (NX) with expiry (PX)
          const result = await redisClient.set(key, 'locked', 'PX', ttlMs, 'NX');
          if (result === 'OK') {
            return true;
          }
        } catch (err: any) {
          console.error(`[LockService] Redis lock acquire failed: ${err.message}. Falling back to memory.`);
          // Fall through to memory fallback if Redis errors out
        }
      }

      // Memory Fallback
      if (!redisClient || !redisClient.status || redisClient.status !== 'ready') {
        const lock = this.localLocks.get(key);
        if (!lock || lock.expiresAt < now) {
          this.localLocks.set(key, { expiresAt: now + ttlMs });
          return true;
        }
      }

      // Check timeout
      if (Date.now() - start > maxWaitMs) {
        return false;
      }

      // Wait before retrying (exponential backoff or sleep)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Releases a lock on a key.
   */
  static async release(key: string): Promise<void> {
    if (redisClient) {
      try {
        await redisClient.del(key);
        return;
      } catch (err: any) {
        console.error(`[LockService] Redis lock release failed: ${err.message}.`);
      }
    }
    
    this.localLocks.delete(key);
  }
}
