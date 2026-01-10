import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";

const LOCK_DIR = join(homedir(), ".opencode-mem");
const LOCK_FILE = join(LOCK_DIR, "webserver.lock");

interface LockData {
  pids: number[];
  port: number;
  host: string;
  startedAt: number;
}

export class WebServerLock {
  private pid: number;

  constructor() {
    this.pid = process.pid;
  }

  async acquire(port: number, host: string): Promise<boolean> {
    try {
      if (existsSync(LOCK_FILE)) {
        const content = readFileSync(LOCK_FILE, "utf-8");
        const lockData: LockData = JSON.parse(content);

        const alivePids = lockData.pids.filter(pid => this.isProcessAlive(pid));

        if (alivePids.length > 0) {
          if (lockData.port === port && lockData.host === host) {
            alivePids.push(this.pid);
            this.writeLock({
              pids: alivePids,
              port: lockData.port,
              host: lockData.host,
              startedAt: lockData.startedAt,
            });
            log("WebServerLock: joined existing server", { 
              pid: this.pid, 
              totalInstances: alivePids.length 
            });
            return false;
          } else {
            log("WebServerLock: port conflict", { 
              requestedPort: port, 
              existingPort: lockData.port 
            });
            throw new Error(`Web server already running on ${lockData.host}:${lockData.port}`);
          }
        }
      }

      this.writeLock({
        pids: [this.pid],
        port,
        host,
        startedAt: Date.now(),
      });

      log("WebServerLock: acquired", { pid: this.pid, port, host });
      return true;

    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) {
        throw error;
      }
      log("WebServerLock: acquire error", { error: String(error) });
      throw error;
    }
  }

  async release(): Promise<boolean> {
    try {
      if (!existsSync(LOCK_FILE)) {
        return true;
      }

      const content = readFileSync(LOCK_FILE, "utf-8");
      const lockData: LockData = JSON.parse(content);

      const remainingPids = lockData.pids.filter(
        pid => pid !== this.pid && this.isProcessAlive(pid)
      );

      if (remainingPids.length === 0) {
        unlinkSync(LOCK_FILE);
        log("WebServerLock: released (last instance)", { pid: this.pid });
        return true;
      } else {
        this.writeLock({
          pids: remainingPids,
          port: lockData.port,
          host: lockData.host,
          startedAt: lockData.startedAt,
        });
        log("WebServerLock: released (instances remaining)", { 
          pid: this.pid, 
          remaining: remainingPids.length 
        });
        return false;
      }

    } catch (error) {
      log("WebServerLock: release error", { error: String(error) });
      return true;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private writeLock(data: LockData): void {
    writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  static cleanup(): void {
    try {
      if (existsSync(LOCK_FILE)) {
        const content = readFileSync(LOCK_FILE, "utf-8");
        const lockData: LockData = JSON.parse(content);

        const alivePids = lockData.pids.filter(pid => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });

        if (alivePids.length === 0) {
          unlinkSync(LOCK_FILE);
          log("WebServerLock: cleanup completed (no alive processes)");
        } else {
          writeFileSync(
            LOCK_FILE,
            JSON.stringify({ ...lockData, pids: alivePids }, null, 2),
            "utf-8"
          );
          log("WebServerLock: cleanup completed (alive processes remain)", { 
            count: alivePids.length 
          });
        }
      }
    } catch (error) {
      log("WebServerLock: cleanup error", { error: String(error) });
    }
  }
}
