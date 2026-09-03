const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || '';

let client;
let subscriber;
let clientConnectPromise;
let subscriberConnectPromise;

function makeClient(name) {
  const redisClient = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy(retries) {
        return Math.min(retries * 250, 5000);
      }
    }
  });

  redisClient.on('error', (error) => {
    console.error(`[REDIS:${name}] ${error.message}`);
  });

  redisClient.on('ready', () => {
    console.log(`[REDIS:${name}] ready`);
  });

  return redisClient;
}

async function getClient() {
  if (!REDIS_URL) return null;

  if (!client) {
    client = makeClient('client');
  }

  if (!client.isOpen) {
    if (!clientConnectPromise) {
      clientConnectPromise = client.connect().catch((error) => {
        clientConnectPromise = null;
        throw error;
      });
    }

    await clientConnectPromise;
  }

  return client;
}

async function getSubscriber() {
  if (!REDIS_URL) return null;

  if (!subscriber) {
    subscriber = makeClient('subscriber');
  }

  if (!subscriber.isOpen) {
    if (!subscriberConnectPromise) {
      subscriberConnectPromise = subscriber.connect().catch((error) => {
        subscriberConnectPromise = null;
        throw error;
      });
    }

    await subscriberConnectPromise;
  }

  return subscriber;
}

async function ping() {
  const redisClient = await getClient();

  if (!redisClient) {
    return {
      enabled: false,
      ready: false
    };
  }

  const response = await redisClient.ping();

  return {
    enabled: true,
    ready: response === 'PONG'
  };
}

async function publish(channel, payload) {
  const redisClient = await getClient();

  if (!redisClient) return false;

  const message =
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  await redisClient.publish(channel, message);
  return true;
}

async function subscribe(channel, handler) {
  const redisSubscriber = await getSubscriber();

  if (!redisSubscriber) return false;

  await redisSubscriber.subscribe(channel, (message) => {
    try {
      handler(JSON.parse(message));
    } catch {
      handler(message);
    }
  });

  return true;
}

async function close() {
  if (client?.isOpen) await client.quit();
  if (subscriber?.isOpen) await subscriber.quit();

  client = null;
  subscriber = null;
  clientConnectPromise = null;
  subscriberConnectPromise = null;
}

module.exports = {
  getClient,
  getSubscriber,
  ping,
  publish,
  subscribe,
  close
};
