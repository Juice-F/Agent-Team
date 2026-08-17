import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export class ObjectStore {
  private readonly root = resolve(".oss-data");

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });

    const probe = join(this.root, `.ping-${randomUUID()}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const full = this.pathOf(key);
    await mkdir(dirname(full), { recursive: true });

    const tmp = `${full}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  private pathOf(key: string): string {
    if (!key || isAbsolute(key)) throw new Error(`key 不合法：${key}`);

    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`key 越界了：${key}`);
    }
    return full;
  }
}

export const oss = new ObjectStore();
