import Redis from "ioredis"

interface CacheClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<string>
}

const redisUrl = process.env.REDIS_URL?.trim()

const disabledRedis: CacheClient = {
  get: async () => null,
  set: async () => "OK",
}

export const redis = redisUrl
  ? new Redis(redisUrl)
  : disabledRedis

if (redisUrl && "on" in redis) {
  redis.on("error", (error) => {
    console.error("[redis] error event:", error)
  })
}

if (!redisUrl) {
  console.warn("[redis] REDIS_URL not configured. Redis cache is disabled.")
}
