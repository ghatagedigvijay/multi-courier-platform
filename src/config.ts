import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default('./data/couriers.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_KEY: z.string().default(''),
  BULK_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(5),
  COURIER_RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(2),
  COURIER_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(250),
  COURIER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  URBANEBOLT_BASE_URL: z.string().url().default('https://uat.urbanebolt.in'),
  URBANEBOLT_USERNAME: z.string().default(''),
  URBANEBOLT_PASSWORD: z.string().default(''),
  URBANEBOLT_AUTH_PATH: z.string().default('/api/v1/auth/getToken/'),
  URBANEBOLT_CREATE_PATH: z.string().default(''),
  URBANEBOLT_TRACK_PATH: z.string().default(''),
  URBANEBOLT_CANCEL_PATH: z.string().default(''),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.API_KEY) {
    context.addIssue({ code: 'custom', path: ['API_KEY'], message: 'API_KEY is required in production' });
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;