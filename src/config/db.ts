import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 100,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (env.NODE_ENV === 'development') {
    console.log('Executed query', { text, duration, rows: res.rowCount });
  }
  return res;
};

export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export const withTransactionRetry = async <T>(
  fn: (client: any) => Promise<T>,
  maxRetries = 5,
  delayMs = 100
): Promise<T> => {
  let attempt = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error: any) {
      await client.query('ROLLBACK');
      
      const isRetryable = error.code === '40001' || error.code === '40P01';
      attempt++;
      
      if (isRetryable && attempt < maxRetries) {
        console.warn(`Database transaction failed (code: ${error.code}). Retrying attempt ${attempt}/${maxRetries} after ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt - 1)));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
};
