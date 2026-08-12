import { createClient } from "redis";
import { redisConfig } from "../config.js";

type Client = ReturnType<typeof createClient>;

export const NS = "agent-team";

class RedisLink {
  private client: Client | null = null;
  private opening: Promise<Client> | null = null;

  async connect(): Promise<void> {
    await this.conn();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.opening = null;
    if (client?.isOpen) await client.close();
  }

  async conn(): Promise<Client> {
    if (this.client?.isReady) return this.client;
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<Client> {
    const client: Client = createClient({ url: redisConfig.url });

    client.on("error", (err: unknown) => {
      console.error("[redis]", err);
    });

    try {
      await client.connect();
    } catch (err) {
      this.opening = null;
      throw err;
    }
    this.client = client;
    return client;
  }
}

export const redis = new RedisLink();
