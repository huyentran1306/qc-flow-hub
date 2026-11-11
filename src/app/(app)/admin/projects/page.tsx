import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { createProjectAction, updateProjectAction } from "@/app/actions/admin";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";

type P = typeof projects.$inferSelect;

function ProjectFields({ p, idp }: { p?: P; idp: string }) {
  const m = p?.mapping;
  return (
    <>
      <label htmlFor={`${idp}-key`}>
        Mã dự án Jira
        <input id={`${idp}-key`} name="key" defaultValue={p?.key} readOnly={!!p} required placeholder="OP" />
      </label>
      <label htmlFor={`${idp}-name`}>
        Tên dự án
        <input id={`${idp}-name`} name="name" defaultValue={p?.name} required />
      </label>
      <label htmlFor={`${idp}-board`}>
        Jira board id <span className="hint">số trong URL board (rapidView=42 hoặc /boards/42)</span>
        <input id={`${idp}-board`} name="jiraBoardId" inputMode="numeric" defaultValue={p?.jiraBoardId ?? ""} />
      </label>
      <label htmlFor={`${idp}-tl`}>
        Tên project trên TestLink
        <input id={`${idp}-tl`} name="testlinkProjectName" defaultValue={p?.testlinkProjectName ?? ""} />
      </label>
      <label htmlFor={`${idp}-story`}>
        Issue type của Story
        <input id={`${idp}-story`} name="storyIssueType" defaultValue={m?.storyIssueType ?? "Story"} />
      </label>
      <label htmlFor={`${idp}-bug`}>
        Issue type của Sub-bug
        <input id={`${idp}-bug`} name="subBugIssueType" defaultValue={m?.subBugIssueType ?? "Sub-bug"} />
      </label>
      <label htmlFor={`${idp}-qc`}>
        Nhận diện subtask của QC <span className="hint">label, hoặc từ khoá trong tiêu đề</span>
        <input id={`${idp}-qc`} name="qcSubtaskLabel" defaultValue={m?.qcSubtaskLabel ?? "QC"} />
      </label>
      <label htmlFor={`${idp}-sev`}>
        Field Severity <span className="hint">dùng ở giai đoạn 2, ví dụ customfield_10045</span>
        <input id={`${idp}-sev`} name="severityField" defaultValue={m?.severityField ?? ""} />
      </label>
      <label htmlFor={`${idp}-env`}>
        Field Environment <span className="hint">select field trên Jira, để trống nếu không có</span>
        <input id={`${idp}-env`} name="environmentField" defaultValue={m?.environmentField ?? ""} />
      </label>
      <label htmlFor={`${idp}-sres`}>
        Trạng thái Jira = Resolved <span className="hint">phân cách bằng dấu phẩy; tool báo QC verify</span>
        <input id={`${idp}-sres`} name="statusResolved" defaultValue={(p?.bugStatusMap.resolved ?? ["Resolved", "Ready for QC", "Ready for Test", "Fixed"]).join(", ")} />
      </label>
      <label htmlFor={`${idp}-sclo`}>
        Trạng thái Jira = Closed <span className="hint">QC verify xong sẽ chuyển bug sang đây</span>
        <input id={`${idp}-sclo`} name="statusClosed" defaultValue={(p?.bugStatusMap.closed ?? ["Closed", "Done"]).join(", ")} />
      </label>
      <label htmlFor={`${idp}-sreo`}>
        Trạng thái khi mở lại bug
        <input id={`${idp}-sreo`} name="statusReopened" defaultValue={(p?.bugStatusMap.reopened ?? ["Reopened", "To Do", "Open"]).join(", ")} />
      </label>
      <label htmlFor={`${idp}-udev`}>
        URL môi trường DEV
        <input id={`${idp}-udev`} name="urlDev" defaultValue={p?.envUrls.dev ?? ""} placeholder="https://dev.app.congty.vn" />
      </label>
      <label htmlFor={`${idp}-ustg`}>
        URL môi trường STAGING
        <input id={`${idp}-ustg`} name="urlStg" defaultValue={p?.envUrls.stg ?? ""} />
      </label>
      <label htmlFor={`${idp}-uprod`}>
        URL môi trường PRODUCTION
        <input id={`${idp}-uprod`} name="urlProd" defaultValue={p?.envUrls.prod ?? ""} />
      </label>
    </>
  );
}

export default async function ProjectsPage({ searchParams }: PageProps<"/admin/projects">) {
  const user = await requireUser();
  if (!user.isAdmin) redirect("/board");
  const sp = await searchParams;
  const list = await (await getDb()).select().from(projects).orderBy(projects.key);
  return (
    <>
      <div className="sh">
        <div>
          <h1>Dự án và ánh xạ</h1>
          <p>Mỗi team cấu hình Jira khác nhau, nên tên issue type và field được ánh xạ ở đây thay vì viết cứng trong code.</p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      {list.map((p) => (
        <div className="card" key={p.id}>
          <h2>
            {p.key} · {p.name} {p.isDemo && <span className="tag">Dự án mẫu</span>}
          </h2>
          <form action={updateProjectAction} className="form">
            <input type="hidden" name="id" value={p.id} />
            <ProjectFields p={p} idp={p.id} />
            <div className="full">
              <SubmitButton className="btn pri">Lưu</SubmitButton>
            </div>
          </form>
        </div>
      ))}
      <div className="card">
        <h2>Thêm dự án</h2>
        <form action={createProjectAction} className="form">
          <ProjectFields idp="new" />
          <label htmlFor="new-role">
            Vai trò của bạn trong dự án
            <select id="new-role" name="myRole" defaultValue="">
              <option value="">Không tham gia (chỉ quản trị)</option>
              <option value="lead">QC Lead</option>
              <option value="qc">QC</option>
            </select>
          </label>
          <div className="full">
            <SubmitButton className="btn pri">Tạo dự án</SubmitButton>
          </div>
        </form>
      </div>
    </>
  );
}
