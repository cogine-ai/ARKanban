import type {
  ActivityDetail,
  ActivitySnapshot,
  AgentOverview,
  CollectorChange,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
} from "../contracts.js";

export type NodeClientOptions = {
  id: string;
  label: string;
  url: string;
  token: string;
};

export class NodeClient {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  private readonly token: string;

  constructor(options: NodeClientOptions) {
    this.id = options.id;
    this.label = options.label;
    this.url = options.url.replace(/\/$/, "");
    this.token = options.token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`node_${this.id}_http_${response.status}`);
    }
    return (await response.json()) as T;
  }

  getStatus(): Promise<CollectorStatus> {
    return this.getJson("/api/v1/meta");
  }

  getSnapshot(): Promise<ActivitySnapshot> {
    return this.getJson("/api/v1/snapshot");
  }

  getSettledGroups(range: SettledRange, rangeEnd: number): Promise<SettledGroupSnapshot> {
    const params = new URLSearchParams({ range, rangeEnd: String(rangeEnd) });
    return this.getJson(`/api/v1/settled-groups?${params}`);
  }

  getSettledSeriesRuns(seriesKey: string, range: SettledRange, rangeEnd: number): Promise<SettledSeriesRuns> {
    const params = new URLSearchParams({ range, rangeEnd: String(rangeEnd) });
    return this.getJson(`/api/v1/settled-groups/${encodeURIComponent(seriesKey)}/runs?${params}`);
  }

  getDetail(id: string): Promise<ActivityDetail> {
    return this.getJson(`/api/v1/activities/${encodeURIComponent(id)}`);
  }

  getAgents(): Promise<{ agents: AgentOverview[] }> {
    return this.getJson("/api/v1/agents");
  }

  /**
   * Subscribes to a node's SSE stream. Returns an unsubscribe function.
   * Reconnect is the caller's responsibility.
   */
  subscribeEvents(handlers: {
    onStatus: (status: CollectorStatus) => void;
    onInvalidate: (change: CollectorChange) => void;
    onError: (error: Error) => void;
  }): () => void {
    const controller = new AbortController();
    void this.readEvents(controller.signal, handlers);
    return () => controller.abort();
  }

  private async readEvents(
    signal: AbortSignal,
    handlers: {
      onStatus: (status: CollectorStatus) => void;
      onInvalidate: (change: CollectorChange) => void;
      onError: (error: Error) => void;
    },
  ): Promise<void> {
    try {
      const response = await fetch(`${this.url}/api/v1/events`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`node_${this.id}_sse_${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          if (!signal.aborted) {
            handlers.onError(new Error(`node_${this.id}_sse_closed`));
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          let event = "message";
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          const payload = dataLines.join("\n");
          try {
            const data = JSON.parse(payload) as unknown;
            if (event === "status") handlers.onStatus(data as CollectorStatus);
            else if (event === "invalidate") handlers.onInvalidate(data as CollectorChange);
          } catch {
            // Ignore malformed frames; the next reconcile refreshes truth.
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
