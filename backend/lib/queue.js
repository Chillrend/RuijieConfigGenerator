import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { pollSwitch } from './poller.js';
import { getDB } from './db.js';

let pollQueue = null;
let pollWorker = null;
let useRedis = false;
let periodicIntervalId = null;

// ponytail: in-memory queue fallback if Redis server is not currently running
class InMemoryQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(name, data) {
    this.queue.push({ name, data });
    this.processNext();
    return { id: String(Date.now()) };
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift();
    try {
      await pollSwitch(item.data.switchId);
    } catch (err) {
      // Logged in poller
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        setTimeout(() => this.processNext(), 500);
      }
    }
  }
}

const memoryQueue = new InMemoryQueue();

export async function initQueue() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  try {
    const testRedis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 1500 });
    await new Promise((resolve, reject) => {
      testRedis.once('connect', resolve);
      testRedis.once('error', reject);
    });

    console.log('Connected to Redis for BullMQ task queue');
    useRedis = true;

    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    pollQueue = new Queue('switch-poll-queue', { connection });

    pollWorker = new Worker(
      'switch-poll-queue',
      async (job) => {
        const { switchId } = job.data;
        return pollSwitch(switchId);
      },
      { connection, concurrency: 5 }
    );

    pollWorker.on('completed', (job) => {
      console.log(`[BullMQ] Switch poll completed for switch ID ${job.data.switchId}`);
    });

    pollWorker.on('failed', (job, err) => {
      console.warn(`[BullMQ] Switch poll failed for switch ID ${job?.data?.switchId}:`, err.message);
    });
  } catch (err) {
    console.warn('Redis not available, using in-memory background task queue:', err.message);
    useRedis = false;
  }
}

export async function enqueueSwitchPoll(switchId) {
  if (useRedis && pollQueue) {
    return pollQueue.add('poll-switch', { switchId }, { removeOnComplete: 100, removeOnFail: 50 });
  }
  return memoryQueue.add('poll-switch', { switchId });
}

export async function enqueueAllSwitches() {
  const db = getDB();
  const switches = await db.all('SELECT id FROM switches');
  for (const sw of switches) {
    await enqueueSwitchPoll(sw.id);
  }
  return { queued: switches.length };
}

export function startPeriodicPolling(intervalMinutes = 5) {
  if (periodicIntervalId) clearInterval(periodicIntervalId);
  console.log(`Starting background switch fleet poller every ${intervalMinutes} minutes`);
  periodicIntervalId = setInterval(async () => {
    try {
      await enqueueAllSwitches();
    } catch (err) {
      console.error('Periodic polling error:', err.message);
    }
  }, intervalMinutes * 60 * 1000);
}
