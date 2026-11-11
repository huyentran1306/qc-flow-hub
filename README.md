# QA Flow Hub

Tool quản lý quy trình test của QC: lấy story từ Jira, AI (Gemini) phân tích requirement và sinh test case, quản lý Q&A, đẩy test case sang TestLink. Thiết kế đầy đủ: xem file PDF thiết kế đi kèm.

Chức năng:

- **Nền tảng**: đăng nhập bằng mật khẩu hoặc SSO (OpenID Connect: Google Workspace, Microsoft Entra ID, Keycloak), phân quyền theo dự án (Admin, QC Lead, QC, Dev, PO/BA), thiết lập 5 bước, kết nối Jira / TestLink / Gemini / Slack / Git webhook, ánh xạ dự án (issue type, field, trạng thái bug, URL môi trường), audit log.
- **Phân tích và test case**: đồng bộ sprint, AI phân tích requirement, Q&A với BA/PO (gửi lên Jira, tự nhận câu trả lời từ comment Jira), AI sinh test case nháp, duyệt, xuất XML hoặc đẩy TestLink.
- **Thực thi**: build theo môi trường và round (DEV-R1, DEV-R2…, STG-R1, PROD-SMOKE), Failed bắt buộc gắn bug, Blocked bắt buộc gắn ticket, evidence, gửi kết quả lên TestLink (test plan, build, bugid), kiểm tra ticket chặn.
- **Sub-bug**: AI viết bug từ TC failed, tạo sub-task trên Jira kèm evidence, đồng bộ trạng thái, gắn commit (Git webhook hoặc nhập tay), verify và đóng kèm evidence đã fix, mở lại.
- **Báo cáo**: số liệu theo round và tích luỹ theo môi trường, theo User Story, AI viết nhận xét, đăng lên Jira và Slack.
- **Môi trường và gate**: quy tắc gate theo dự án, kiểm tra tự động, báo dev deploy, vượt gate có lý do (QC Lead), bộ happy case cho Production.
- **AI Agent / Antigravity**: token MCP cá nhân, MCP server stdio (`packaging/mcp-stdio.mjs`) với 8 tool, hàng chờ duyệt cho mọi thứ AI tạo.

## Chạy trên máy

Yêu cầu: Node.js 20+.

```bash
npm install
cp .env.example .env.local      # rồi điền APP_SECRET: openssl rand -base64 48
npm run dev                     # http://localhost:3000
```

Lần đầu mở sẽ vào màn **Thiết lập lần đầu** để tạo tài khoản Admin. Sau đó:

1. **Quản trị → Kết nối**: nhập Jira, TestLink, Gemini rồi bấm *Lưu và kiểm tra*.
2. **Quản trị → Dự án**: tạo dự án với mã Jira (ví dụ `OP`), board id, tên project TestLink.
3. **Quản trị → Người dùng**: tạo tài khoản và gán vai trò (QC Lead, QC, Dev, PO / BA).
4. **Sprint board → Đồng bộ Jira**, mở một story, bấm *Phân tích*, *AI sinh test case*, duyệt, rồi *Đẩy lên TestLink* (hoặc *Tải XML TestLink* để import tay).

Chưa có Jira? Ở Sprint board, Admin bấm **Tạo dự án mẫu** để thử với 3 story có sẵn.

## Gửi cho người không rành kỹ thuật (bấm đúp là chạy)

```bash
npm run package                  # dist/QA-Flow-Hub-{mac-arm64,mac-x64,win-x64}.zip
npm run package -- win-x64       # chỉ một bản
```

Mỗi file zip có sẵn Node bên trong, không cần cài gì. Người dùng giải nén rồi bấm đúp `start-windows.bat` (Windows) hoặc `start-mac.command` (Mac), trình duyệt tự mở. Dữ liệu và khoá mã hoá nằm trong thư mục `data` cạnh file khởi động. Hướng dẫn cho người dùng: `packaging/HUONG-DAN.txt` (được copy vào gói).

## Dữ liệu

- Mặc định dùng **PGlite** (Postgres nhúng), dữ liệu nằm ở `./.data/pglite`. Không cần cài database.
- Trên server: đặt `DATABASE_URL` trỏ tới Postgres. Migration tự chạy khi app khởi động.
- Token Jira/TestLink/Gemini được mã hoá AES-256-GCM bằng khoá suy ra từ `APP_SECRET`. Đổi `APP_SECRET` thì phải nhập lại token.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run dev` | chạy dev |
| `npm run build && npm start` | chạy bản production |
| `npm test` | unit test + test nghiệp vụ trên PGlite in-memory |
| `npm run lint` | ESLint |
| `npm run db:generate` | tạo migration sau khi sửa `src/lib/db/schema.ts` |

## Cấu trúc

```
src/lib/db/            schema (Drizzle) và kết nối PGlite/Postgres
src/lib/integrations/  Jira (REST), TestLink (XML-RPC), Gemini
src/lib/services/      nghiệp vụ: đồng bộ, AI, Q&A, test case, người dùng, dự án
src/lib/rbac.ts        ma trận quyền theo vai trò
src/app/actions/       server action, luôn kiểm tra quyền trước khi chạy
src/app/(app)/         các màn hình sau đăng nhập
tests/                 Vitest
```

## Antigravity (MCP)

Mỗi người tạo token ở **Hồ sơ**, trang hiện sẵn đoạn cấu hình MCP để dán vào Antigravity. Server MCP là `packaging/mcp-stdio.mjs` (không cần thư viện), gọi `POST /api/agent` của tool bằng token. Tool: `list_sprint_stories`, `get_story`, `propose_test_cases`, `get_build_testcases`, `record_execution`, `upload_evidence`, `draft_bug`, `get_bug`.

## Webhook (khi chạy trên server mà Jira/GitLab gọi tới được)

- Jira: `POST /api/webhooks/jira?secret=…` (URL đầy đủ ở màn Kết nối), sự kiện Issue updated.
- GitLab/GitHub: `POST /api/webhooks/git`, sự kiện Push, secret nhập ở màn Kết nối.

## Server cho cả team (Docker)

```bash
cp .env.example .env     # điền APP_SECRET, APP_URL, POSTGRES_PASSWORD
docker compose up -d --build
```

Image chạy `server.js` của bản standalone với Postgres (`DATABASE_URL`), file evidence ở volume `/data`. Migration tự chạy khi khởi động. Sao lưu cả volume `db` và `files`.

## SSO

Quản trị → Kết nối → Đăng nhập SSO: Issuer URL, Client ID, Client secret. Đăng ký Redirect URI `APP_URL/auth/sso/callback` ở Google Cloud Console / Microsoft Entra. Microsoft dùng issuer theo tenant (`https://login.microsoftonline.com/<tenant-id>/v2.0`). Chỉ email đã có tài khoản trong tool mới đăng nhập được.
