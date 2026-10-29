import Redis from "ioredis"

interface CacheClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<string>
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<string>
  del(key: string): Promise<number>
}

const redisUrl = process.env.REDIS_URL?.trim()

const disabledRedis: CacheClient = {
  get: async () => null,
  set: async () => "OK",
  setWithTtl: async () => "OK",
  del: async () => 0,
}

const createRedisClient = (url: string): CacheClient => {
  const client = new Redis(url)
  client.on("error", (error) => {
    console.error("[redis] error event:", error)
  })
  return {
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, value),
    setWithTtl: (key, value, ttlSeconds) => client.setex(key, ttlSeconds, value),
    del: (key) => client.del(key),
  }
}

export const redis: CacheClient = redisUrl
  ? createRedisClient(redisUrl)
  : disabledRedis

if (!redisUrl) {
  console.warn("[redis] REDIS_URL not configured. Redis cache is disabled.")
}
