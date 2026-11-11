import { IntegrationError, fetchWithTimeout } from "./http";
import type { JiraSubtask } from "../db/schema";

export type JiraConfig = {
  baseUrl: string;
  flavor: "cloud" | "dc"; // Cloud: email + API token (Basic). Server/Data Center: PAT (Bearer).
  email?: string;
  token: string;
};

export type JiraSprint = { id: number; name: string; state: string; startDate?: string; endDate?: string };
export type JiraStory = {
  key: string;
  summary: string;
  description: string;
  status: string;
  subtasks: JiraSubtask[];
};

type AdfNode = { type?: string; text?: string; content?: AdfNode[] };

/** Jira Cloud may return descriptions as Atlassian Document Format; flatten to plain text. */
export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const n = node as AdfNode;
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfToText).join("");
  const block = ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"];
  if (n.type === "listItem") return `- ${inner.trim()}\n`;
  return block.includes(n.type ?? "") ? `${inner}\n` : inner;
}

export class JiraClient {
  constructor(private cfg: JiraConfig) {}

  private headers(): Record<string, string> {
    const auth =
      this.cfg.flavor === "cloud"
        ? `Basic ${Buffer.from(`${this.cfg.email ?? ""}:${this.cfg.token}`).toString("base64")}`
        : `Bearer ${this.cfg.token}`;
    return { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = this.cfg.baseUrl.replace(/\/+$/, "") + path;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    } catch (e) {
      throw new IntegrationError("Jira", `không kết nối được tới ${this.cfg.baseUrl} (${(e as Error).message})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint =
        res.status === 401 ? "sai email/token" : res.status === 403 ? "token không đủ quyền" : res.status === 404 ? "không tìm thấy (sai URL hoặc board id?)" : "";
      throw new IntegrationError("Jira", `HTTP ${res.status}${hint ? ` – ${hint}` : ""} ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Returns the display name of the account the token belongs to. */
  async myself(): Promise<string> {
    const me = await this.request<{ displayName?: string; emailAddress?: string; name?: string }>("/rest/api/2/myself");
    return me.displayName ?? me.emailAddress ?? me.name ?? "unknown";
  }

  async activeSprints(boardId: number): Promise<JiraSprint[]> {
    const r = await this.request<{ values: JiraSprint[] }>(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    return r.values ?? [];
  }

  /** Stories in a sprint, with their subtasks. Uses the Agile API, available on Cloud and Data Center. */
  async sprintStories(sprintId: number, storyIssueType: string): Promise<JiraStory[]> {
    const out: JiraStory[] = [];
    const jql = encodeURIComponent(`issuetype = "${storyIssueType}"`);
    const fields = "summary,description,status,subtasks";
    let startAt = 0;
    for (;;) {
      const r = await this.request<{
        issues: { key: string; fields: { summary: string; description: unknown; status?: { name: string }; subtasks?: { key: string; fields: { summary: string; status?: { name: string }; issuetype?: { name: string } } }[] } }[];
        total: number;
        maxResults: number;
      }>(`/rest/agile/1.0/sprint/${sprintId}/issue?jql=${jql}&fields=${fields}&startAt=${startAt}&maxResults=50`);
      for (const i of r.issues) {
        out.push({
          key: i.key,
          summary: i.fields.summary,
          description: adfToText(i.fields.description).trim(),
          status: i.fields.status?.name ?? "",
          subtasks: (i.fields.subtasks ?? []).map((s) => ({
            key: s.key,
            summary: s.fields.summary,
            status: s.fields.status?.name ?? "",
            issueType: s.fields.issuetype?.name ?? "",
            labels: [],
          })),
        });
      }
      startAt += r.issues.length;
      if (r.issues.length === 0 || startAt >= r.total) break;
    }
    return out;
  }

  /** Plain-text comment. API v2 accepts a string body on both Cloud and Data Center. */
  async addComment(issueKey: string, body: string): Promise<string> {
    const r = await this.request<{ id: string }>(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return r.id;
  }

  async issueStatus(key: string): Promise<string> {
    const r = await this.request<{ fields: { status?: { name: string } } }>(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`);
    return r.fields.status?.name ?? "";
  }

  /** Creates an issue (sub-task when parentKey is given). Description uses wiki markup (API v2). */
  async createIssue(input: {
    projectKey: string;
    issueType: string;
    summary: string;
    description: string;
    parentKey?: string;
    extraFields?: Record<string, unknown>;
  }): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary.slice(0, 250),
      description: input.description,
      ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
      ...(input.extraFields ?? {}),
    };
    const r = await this.request<{ key: string }>("/rest/api/2/issue", { method: "POST", body: JSON.stringify({ fields }) });
    return r.key;
  }

  async attachFile(issueKey: string, fileName: string, data: Buffer, mime: string): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), fileName);
    const headers = this.headers();
    delete headers["Content-Type"]; // let fetch set the multipart boundary
    const url = this.cfg.baseUrl.replace(/\/+$/, "") + `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`;
    const res = await fetchWithTimeout(url, { method: "POST", headers: { ...headers, "X-Atlassian-Token": "no-check" }, body: form }, 60000);
    if (!res.ok) throw new IntegrationError("Jira", `đính kèm file lỗi HTTP ${res.status}`, res.status);
  }

  /** Moves the issue to the first available transition whose target status is in `statusNames`. */
  async transitionTo(issueKey: string, statusNames: string[]): Promise<string | null> {
    const r = await this.request<{ transitions: { id: string; name: string; to?: { name: string } }[] }>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    const wanted = statusNames.map((n) => n.toLowerCase());
    const t = r.transitions.find((x) => wanted.includes((x.to?.name ?? "").toLowerCase()) || wanted.includes(x.name.toLowerCase()));
    if (!t) return null;
    const res = await fetchWithTimeout(this.cfg.baseUrl.replace(/\/+$/, "") + `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ transition: { id: t.id } }),
    });
    if (!res.ok) throw new IntegrationError("Jira", `chuyển trạng thái lỗi HTTP ${res.status}`, res.status);
    return t.to?.name ?? t.name;
  }

  /** Account id (Cloud) or username (Server/DC) of the token owner, used to skip the bot's own comments. */
  async myselfId(): Promise<string> {
    const me = await this.request<{ accountId?: string; name?: string; key?: string }>("/rest/api/2/myself");
    return me.accountId ?? me.name ?? me.key ?? "";
  }

  async listComments(issueKey: string): Promise<JiraComment[]> {
    const r = await this.request<{ comments: { id: string; body: unknown; created: string; author?: { accountId?: string; name?: string; displayName?: string } }[] }>(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?orderBy=created&maxResults=100`,
    );
    return (r.comments ?? []).map((c) => ({
      id: String(c.id),
      body: adfToText(c.body).trim(),
      created: c.created,
      authorId: c.author?.accountId ?? c.author?.name ?? "",
      authorName: c.author?.displayName ?? c.author?.name ?? "",
    }));
  }
}

export type JiraComment = { id: string; body: string; created: string; authorId: string; authorName: string };
