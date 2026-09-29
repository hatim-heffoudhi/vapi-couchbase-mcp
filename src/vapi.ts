const VAPI_API = "https://api.vapi.ai";

export class VapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class VapiClient {
  constructor(private readonly apiKey: string) {}

  async createMcpTool(input: {
    name: string;
    serverUrl: string;
    authHeader?: string;
  }) {
    const headers: Record<string, string> = {};
    if (input.authHeader) {
      headers.Authorization = input.authHeader;
    }

    return this.request("POST", "/tool", {
      type: "mcp",
      function: {
        name: input.name,
        description:
          "Couchbase MCP tools for order lookups: get documents by ID and run SQL++ queries.",
      },
      server: {
        url: input.serverUrl,
        timeoutSeconds: 30,
        ...(Object.keys(headers).length ? { headers } : {}),
      },
      metadata: {
        protocol: "shttp",
      },
    });
  }

  async createApiRequestTool(input: {
    name: string;
    description: string;
    method: "GET" | "POST";
    url: string;
    bodyProperties?: Record<string, { type: string; description: string }>;
    required?: string[];
    timeoutSeconds?: number;
  }) {
    return this.request("POST", "/tool", {
      type: "apiRequest",
      function: {
        name: input.name,
        description: input.description,
      },
      method: input.method,
      url: input.url,
      timeoutSeconds: input.timeoutSeconds ?? 25,
      ...(input.bodyProperties
        ? {
            body: {
              type: "object",
              properties: input.bodyProperties,
              required: input.required ?? Object.keys(input.bodyProperties),
            },
          }
        : {}),
    });
  }

  async updateTool(id: string, payload: Record<string, unknown>) {
    return this.request("PATCH", `/tool/${id}`, payload);
  }

  async createAssistant(payload: Record<string, unknown>) {
    return this.request("POST", "/assistant", payload);
  }

  async updateAssistant(id: string, payload: Record<string, unknown>) {
    return this.request("PATCH", `/assistant/${id}`, payload);
  }

  async listAssistants() {
    return this.request("GET", "/assistant");
  }

  async getAssistant(id: string) {
    return this.request("GET", `/assistant/${id}`);
  }

  async listTools() {
    return this.request("GET", "/tool");
  }

  async getTool(id: string) {
    return this.request("GET", `/tool/${id}`);
  }

  async deleteAssistant(id: string) {
    return this.request("DELETE", `/assistant/${id}`);
  }

  async deleteTool(id: string) {
    return this.request("DELETE", `/tool/${id}`);
  }

  private async request(method: string, pathname: string, body?: unknown) {
    const response = await fetch(`${VAPI_API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      throw new VapiError(
        `Vapi ${method} ${pathname} failed (${response.status}): ${text}`,
        response.status,
        text,
      );
    }

    return data;
  }
}
