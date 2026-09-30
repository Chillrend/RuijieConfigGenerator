import IORedis from 'ioredis';

let redisClient = null;

export function getRedis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new IORedis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      }
    });
    redisClient.on('error', (err) => {
      // Non-blocking warning
    });
  }
  return redisClient;
}
