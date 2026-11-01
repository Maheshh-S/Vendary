import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { isRedisEnabled, redis } from "@/lib/redis";

/**
 * Deep health endpoint for the Docker HEALTHCHECK and uptime monitors.
 *
 * Contract:
 *   { status: "ok" | "degraded" | "error",
 *     checks: { db: "up" | "down", redis: "up" | "down" | "disabled" },
 *     version, uptimeS }
 *
 * - DB is the only hard dependency: any failure is HTTP 503 so a container is
 *   restarted. Redis is optional/degradable: a configured-but-down Redis is
 *   reported but keeps HTTP 200 (`degraded`), matching the cache's fallback
 *   behaviour.
 * - Both probes are bounded to 1s so a hung dependency cannot stall the
 *   healthcheck (and Docker's `--timeout=5s` never trips on our own wait).
 * - No configuration values, hosts or error messages are returned or logged:
 *   the body is safe to expose and the log line carries a fixed reason code.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 1000;

class CheckTimeoutError extends Error {}

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError("check timed out")), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

type Probe = "up" | "down";

const checkDb = async (): Promise<Probe> => {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return "up";
  } catch (error) {
    // Error classes only: messages can embed the connection string.
    logger.warn("status_check_failed", {
      check: "db",
      reason: error instanceof CheckTimeoutError ? "timeout" : "error",
    });
    return "down";
  }
};

const checkRedis = async (): Promise<Probe | "disabled"> => {
  if (!isRedisEnabled) {
    return "disabled";
  }
  try {
    const reply = await withTimeout(redis.ping(), CHECK_TIMEOUT_MS);
    return reply === "PONG" ? "up" : "down";
  } catch (error) {
    logger.warn("status_check_failed", {
      check: "redis",
      reason: error instanceof CheckTimeoutError ? "timeout" : "error",
    });
    return "down";
  }
};

export async function GET() {
  const [db, redisCheck] = await Promise.all([checkDb(), checkRedis()]);

  const status = db === "down" ? "error" : redisCheck === "down" ? "degraded" : "ok";

  return NextResponse.json(
    {
      status,
      checks: { db, redis: redisCheck },
      version: process.env.GIT_SHA ?? "dev",
      uptimeS: Math.round(process.uptime()),
    },
    {
      status: db === "up" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    }
  );
}
