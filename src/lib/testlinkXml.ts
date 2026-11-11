import type { TcPriority, TcStep, TcType } from "./db/schema";

type XmlTc = { seq: number; usCode: string; type: TcType; title: string; priority: TcPriority; preconditions: string; requirementRef: string | null; steps: TcStep[] };

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const IMPORTANCE: Record<TcPriority, number> = { high: 3, medium: 2, low: 1 };

export function testcaseName(tc: Pick<XmlTc, "usCode" | "type" | "title">): string {
  return `[${tc.usCode}][${tc.type}] ${tc.title}`;
}

/** TestLink 1.9 test suite XML (Test Specification → Import). */
export function toTestlinkXml(suiteName: string, tcs: XmlTc[]): string {
  const cases = tcs
    .map(
      (tc) => `  <testcase name="${attr(testcaseName(tc))}">
    <summary>${cdata(tc.requirementRef ? `Ref: ${tc.requirementRef}` : "")}</summary>
    <preconditions>${cdata(tc.preconditions)}</preconditions>
    <importance>${IMPORTANCE[tc.priority]}</importance>
    <execution_type>1</execution_type>
    <steps>
${tc.steps
  .map(
    (s, i) => `      <step>
        <step_number>${i + 1}</step_number>
        <actions>${cdata(s.action)}</actions>
        <expectedresults>${cdata(s.expected)}</expectedresults>
        <execution_type>1</execution_type>
      </step>`,
  )
  .join("\n")}
    </steps>
  </testcase>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${attr(suiteName)}">\n${cases}\n</testsuite>\n`;
}
