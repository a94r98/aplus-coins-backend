import app from './app';
import { env } from './config/env';
import { pool } from './config/db';

import { redisClient } from './config/redis';

const PORT = env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
});

// Automatic cleanup of idempotency keys older than 7 days
const runIdempotencyCleanup = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '7 days'`
    );
    console.log(`🧹 Cleaned up old idempotency keys. Rows deleted: ${result.rowCount}`);
  } catch (error) {
    console.error('❌ Failed to clean up old idempotency keys:', error);
  }
};

// Run immediately on start, and then every 24 hours
runIdempotencyCleanup();
const cleanupInterval = setInterval(runIdempotencyCleanup, 24 * 60 * 60 * 1000);

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Stopping server and database connections...');
  clearInterval(cleanupInterval);
  server.close(async () => {
    console.log('HTTP server closed.');
    await pool.end();
    console.log('Database pool closed.');
    if (redisClient) {
      await redisClient.quit();
      console.log('Redis connection closed.');
    }
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
