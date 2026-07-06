import { createApp } from "./app";
import { env } from "./lib/env";
import { prisma } from "./lib/prisma";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`WeLockin backend listening on http://localhost:${env.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
