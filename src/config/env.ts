import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().default('super_secret_jwt_key_change_me_in_production'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/reward_db'),
  REDIS_URL: z.string().optional(),
  COOLDOWN_SECONDS: z.coerce.number().default(30),
  DAILY_AD_LIMIT_FREE: z.coerce.number().default(5),
  DAILY_AD_LIMIT_VIP1: z.coerce.number().default(10),
  DAILY_AD_LIMIT_VIP2: z.coerce.number().default(20),
  DAILY_AD_LIMIT_VIP3: z.coerce.number().default(40),
  MIN_WITHDRAWAL: z.coerce.number().default(10),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
