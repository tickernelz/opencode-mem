import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { WebServerLock } from "./web-server-lock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebServerConfig {
  port: number;
  host: string;
  enabled: boolean;
}

interface WorkerMessage {
  type: "start" | "stop" | "status";
  port?: number;
  host?: string;
}

interface WorkerResponse {
  type: "started" | "stopped" | "error" | "status";
  url?: string;
  error?: string;
  running?: boolean;
}

export class WebServer {
  private worker: Worker | null = null;
  private config: WebServerConfig;
  private lock: WebServerLock;
  private isOwner: boolean = false;
  private startPromise: Promise<void> | null = null;

  constructor(config: WebServerConfig) {
    this.config = config;
    this.lock = new WebServerLock();
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this._start();
    return this.startPromise;
  }

  private async _start(): Promise<void> {
    if (!this.config.enabled) {
      log("Web server disabled in config");
      return;
    }

    try {
      this.isOwner = await this.lock.acquire(this.config.port, this.config.host);

      if (!this.isOwner) {
        log("Web server already running, joined existing instance");
        return;
      }

      const workerPath = join(__dirname, "web-server-worker.js");
      this.worker = new Worker(workerPath);

      const startedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Worker start timeout"));
        }, 10000);

        this.worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
          clearTimeout(timeout);
          const response = event.data;

          if (response.type === "started") {
            log("Web server started in worker", { url: response.url });
            resolve();
          } else if (response.type === "error") {
            log("Web server worker error", { error: response.error });
            reject(new Error(response.error));
          }
        };

        this.worker!.onerror = (error) => {
          clearTimeout(timeout);
          log("Web server worker error", { error: String(error) });
          reject(error);
        };
      });

      this.worker.postMessage({
        type: "start",
        port: this.config.port,
        host: this.config.host,
      } as WorkerMessage);

      await startedPromise;

    } catch (error) {
      this.isOwner = false;
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      await this.lock.release();
      log("Web server failed to start", { error: String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const shouldStop = await this.lock.release();

    if (shouldStop && this.worker) {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.worker) {
            this.worker.terminate();
            this.worker = null;
          }
          log("Web server stopped (timeout, forced termination)");
          resolve();
        }, 5000);

        this.worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
          clearTimeout(timeout);
          const response = event.data;

          if (response.type === "stopped") {
            if (this.worker) {
              this.worker.terminate();
              this.worker = null;
            }
            log("Web server stopped (last instance)");
            resolve();
          }
        };

        this.worker!.postMessage({
          type: "stop",
        } as WorkerMessage);
      });
    } else if (!shouldStop) {
      log("Web server kept alive (other instances running)");
    }
  }

  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }
}

export async function startWebServer(config: WebServerConfig): Promise<WebServer> {
  const server = new WebServer(config);
  await server.start();
  return server;
}
