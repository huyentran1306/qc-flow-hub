import { IntegrationError, fetchWithTimeout } from "./http";
import { decodeResponse, encodeCall, RpcFault, type RpcValue } from "./xmlrpc";
import type { TcPriority, TcStep } from "../db/schema";

export type TestLinkConfig = { url: string; devKey: string; authorLogin: string };

const IMPORTANCE: Record<TcPriority, number> = { high: 3, medium: 2, low: 1 };

export class TestLinkClient {
  constructor(private cfg: TestLinkConfig) {}

  async call(method: string, args: Record<string, RpcValue> = {}): Promise<RpcValue> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.cfg.url, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: encodeCall(method, [{ devKey: this.cfg.devKey, ...args }]),
      });
    } catch (e) {
      throw new IntegrationError("TestLink", `không kết nối được tới ${this.cfg.url} (${(e as Error).message})`);
    }
    if (!res.ok) throw new IntegrationError("TestLink", `HTTP ${res.status}`, res.status);
    let value: RpcValue;
    try {
      value = decodeResponse(await res.text());
    } catch (e) {
      if (e instanceof RpcFault) throw new IntegrationError("TestLink", e.message);
      throw new IntegrationError("TestLink", "phản hồi không phải XML-RPC (sai URL API?)");
    }
    // TestLink reports errors as [{code, message}] instead of XML-RPC faults.
    if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "code" in (value[0] as object) && "message" in (value[0] as object)) {
      const e = value[0] as { code: number; message: string };
      throw new IntegrationError("TestLink", `${e.message} (code ${e.code})`);
    }
    return value;
  }

  async checkDevKey(): Promise<void> {
    const ok = await this.call("tl.checkDevKey");
    if (ok !== true && ok !== "1") throw new IntegrationError("TestLink", "API key không hợp lệ");
  }

  async projectByName(name: string): Promise<{ id: string; prefix: string }> {
    const p = (await this.call("tl.getTestProjectByName", { testprojectname: name })) as Record<string, RpcValue>;
    return { id: String(p.id), prefix: String(p.prefix ?? "") };
  }

  /** Finds a first-level suite by name, creating it when missing. */
  async ensureSuite(projectId: string, name: string, details: string): Promise<string> {
    let suites: RpcValue = [];
    try {
      suites = await this.call("tl.getFirstLevelTestSuitesForTestProject", { testprojectid: projectId });
    } catch {
      suites = []; // TestLink returns an error when the project has no suites yet
    }
    const list = Array.isArray(suites) ? suites : Object.values(suites as Record<string, RpcValue>);
    const hit = list.find((s) => (s as Record<string, RpcValue>)?.name === name) as Record<string, RpcValue> | undefined;
    if (hit) return String(hit.id);
    const r = (await this.call("tl.createTestSuite", { testprojectid: projectId, testsuitename: name, details })) as RpcValue[];
    return String((r[0] as Record<string, RpcValue>).id);
  }

  async createTestCase(input: {
    projectId: string;
    suiteId: string;
    name: string;
    summary: string;
    preconditions: string;
    priority: TcPriority;
    steps: TcStep[];
  }): Promise<{ id: string; externalId: string | null }> {
    const r = (await this.call("tl.createTestCase", {
      testprojectid: input.projectId,
      testsuiteid: input.suiteId,
      testcasename: input.name,
      authorlogin: this.cfg.authorLogin,
      summary: input.summary,
      preconditions: input.preconditions,
      importance: IMPORTANCE[input.priority],
      executiontype: 1,
      steps: input.steps.map((s, i) => ({ step_number: i + 1, actions: s.action, expected_results: s.expected, execution_type: 1 })),
    })) as RpcValue[];
    const first = (Array.isArray(r) ? r[0] : r) as Record<string, RpcValue>;
    const info = (first.additionalInfo ?? {}) as Record<string, RpcValue>;
    return { id: String(first.id), externalId: info.external_id != null ? String(info.external_id) : null };
  }

  async testCaseVersion(externalId: string): Promise<number> {
    const r = (await this.call("tl.getTestCase", { testcaseexternalid: externalId })) as RpcValue[];
    const first = (Array.isArray(r) ? r[0] : r) as Record<string, RpcValue>;
    return Number(first?.version ?? 1);
  }

  /** Finds the test plan by name or creates it. */
  async ensureTestPlan(projectName: string, planName: string): Promise<string> {
    try {
      const r = (await this.call("tl.getTestPlanByName", { testprojectname: projectName, testplanname: planName })) as RpcValue[];
      const first = (Array.isArray(r) ? r[0] : r) as Record<string, RpcValue>;
      if (first?.id) return String(first.id);
    } catch {
      /* not found → create */
    }
    const r = (await this.call("tl.createTestPlan", { testprojectname: projectName, testplanname: planName, notes: "Tạo bởi QA Flow Hub", active: 1, public: 1 })) as RpcValue[];
    return String(((Array.isArray(r) ? r[0] : r) as Record<string, RpcValue>).id);
  }

  async addToPlan(projectId: string, planId: string, externalId: string): Promise<void> {
    const version = await this.testCaseVersion(externalId);
    try {
      await this.call("tl.addTestCaseToTestPlan", { testprojectid: projectId, testplanid: planId, testcaseexternalid: externalId, version });
    } catch (e) {
      // Already linked is fine.
      if (!/already|linked|exist/i.test((e as Error).message)) throw e;
    }
  }

  async createBuild(planId: string, name: string): Promise<string> {
    const r = (await this.call("tl.createBuild", { testplanid: planId, buildname: name, buildnotes: "Tạo bởi QA Flow Hub" })) as RpcValue[];
    return String(((Array.isArray(r) ? r[0] : r) as Record<string, RpcValue>).id);
  }

  async reportResult(input: { planId: string; buildName: string; externalId: string; status: "p" | "f" | "b"; notes: string; bugId?: string }): Promise<void> {
    await this.call("tl.reportTCResult", {
      testplanid: input.planId,
      buildname: input.buildName,
      testcaseexternalid: input.externalId,
      status: input.status,
      notes: input.notes,
      guess: false,
      ...(input.bugId ? { bugid: input.bugId } : {}),
    });
  }
}
