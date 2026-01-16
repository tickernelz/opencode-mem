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
            resolve();
          } else if (response.type === "error") {
            const errorMsg = response.error || "Unknown error";

            if (errorMsg.includes("EADDRINUSE") || errorMsg.includes("address already in use")) {
              this.isOwner = false;
              resolve();
            } else {
              log("Web server worker error", { error: errorMsg });
              reject(new Error(errorMsg));
            }
          }
        };

        this.worker!.onerror = (error: ErrorEvent) => {
          clearTimeout(timeout);
          const errorDetails = {
            message: error.message || "Unknown error",
            filename: error.filename || "unknown",
            lineno: error.lineno || 0,
            colno: error.colno || 0,
            error: error.error ? String(error.error) : "no error object",
            type: error.type || "error",
          };
          log("Web server worker error (detailed)", errorDetails);
          
          const errorMsg = error.message 
            ? `${error.message} (at ${error.filename}:${error.lineno}:${error.colno})`
            : error.error 
              ? String(error.error)
              : `Worker failed: ${JSON.stringify(errorDetails)}`;
          reject(new Error(errorMsg));
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
      return;
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
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
        method: "GET",
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
