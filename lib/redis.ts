import Redis from "ioredis"

interface CacheClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<string>
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<string>
  del(key: string): Promise<number>
  incr(key: string): Promise<number>
  pexpire(key: string, ttlMs: number): Promise<number>
}

const redisUrl = process.env.REDIS_URL?.trim()

/** False when `REDIS_URL` is unset/blank; callers should use their fallback. */
export const isRedisEnabled = Boolean(redisUrl)

const disabledRedis: CacheClient = {
  get: async () => null,
  set: async () => "OK",
  setWithTtl: async () => "OK",
  del: async () => 0,
  incr: async () => 0,
  pexpire: async () => 0,
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
    incr: (key) => client.incr(key),
    pexpire: (key, ttlMs) => client.pexpire(key, ttlMs),
  }
}

export const redis: CacheClient = redisUrl
  ? createRedisClient(redisUrl)
  : disabledRedis

if (!redisUrl) {
  console.warn("[redis] REDIS_URL not configured. Redis cache is disabled.")
}
