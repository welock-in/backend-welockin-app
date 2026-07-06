import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number.parseInt(process.env.PORT ?? "8787", 10),
  databaseUrl: required("DATABASE_URL", "mongodb://localhost:27017/welockin"),
  jwtSecret: required("JWT_SECRET", "change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  nodeEnv: process.env.NODE_ENV ?? "development",
};

export type Env = typeof env;
