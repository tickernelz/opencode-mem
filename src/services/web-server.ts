import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

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
  private isOwner: boolean = false;
  private startPromise: Promise<void> | null = null;

  constructor(config: WebServerConfig) {
    this.config = config;
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
            this.isOwner = true;
            log("Web server started (owner)", { url: response.url });
            resolve();
          } else if (response.type === "error") {
            const errorMsg = response.error || "Unknown error";
            
            if (errorMsg.includes("EADDRINUSE") || errorMsg.includes("address already in use")) {
              this.isOwner = false;
              log("Web server already running (port in use)");
              resolve();
            } else {
              log("Web server worker error", { error: errorMsg });
              reject(new Error(errorMsg));
            }
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
      log("Web server failed to start", { error: String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isOwner || !this.worker) {
      log("Web server stop skipped (not owner or no worker)");
      return;
    }

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
          log("Web server stopped (owner exiting)");
          resolve();
        }
      };

      this.worker!.postMessage({
        type: "stop",
      } as WorkerMessage);
    });
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  isServerOwner(): boolean {
    return this.isOwner;
  }

  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async checkServerAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getUrl()}/api/stats`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export async function startWebServer(config: WebServerConfig): Promise<WebServer> {
  const server = new WebServer(config);
  await server.start();
  return server;
}
