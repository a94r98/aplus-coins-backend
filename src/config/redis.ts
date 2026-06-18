import Redis from 'ioredis';
import { env } from './env';

let redisClient: Redis | null = null;

if (env.REDIS_URL) {
  console.log('🔌 Connecting to Redis...');
  redisClient = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
    // Required for SSL connections (like Upstash rediss:// URLs)
    tls: env.REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });

  redisClient.on('connect', () => {
    console.log('✅ Redis connected successfully.');
  });

  redisClient.on('error', (err) => {
    console.error('❌ Redis Connection Error:', err.message);
  });
} else {
  console.warn('⚠️ REDIS_URL not configured. Running in local-memory fallback mode.');
}

export { redisClient };
