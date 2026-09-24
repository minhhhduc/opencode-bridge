# Handoff — omp-opencode-bridge

Đọc file này để tiếp tục. Không cần đọc transcript cũ.

## Dự án

Plugin OMP (Oh My Pi v18.2.6) tại `D:\unknown\tool\omp`. Hai phần:
1. Bridge model OpenCode → OMP (dynamic discovery, không hardcode danh sách model).
2. Audit manifest plugin bên thứ ba trước khi cài (`plugin-audit`).

## Trạng thái: phần discovery ĐÃ CHẠY THẬT, phần inference CHƯA

```
$ omp --model opencode-bridge/opencode/big-pickle -p "hi"
Working...
401 Model opencode/big-pickle is not supported
```

Model resolve được, request tới được OpenCode, OpenCode từ chối model đó.
401 là của OpenCode (model free cần auth), KHÔNG phải lỗi bridge.
Test: 33/33 pass (`npm test`).

## Plugin đã cài

- `C:\Users\Admin\.omp\plugins\package.json` (đã tạo tay) trỏ
  `omp-opencode-bridge` → `file:D:/unknown/tool/omp`
- Dùng **directory junction** thay symlink (Windows chặn symlink, EPERM):
  `C:\Users\Admin\.omp\plugins\node_modules\omp-opencode-bridge` → `D:\unknown\tool\omp`
- Sửa code trong thư mục gốc là chạy luôn, không cần cài lại.

## Facts về OMP đã xác minh (đừng đoán lại, rất tốn thời gian)

Tìm bằng cách đọc/decompile `C:\Users\Admin\AppData\Local\omp\omp.exe` (binary Bun, không
có source sạch; npm package `@oh-my-pi/cli` là dòng sản phẩm KHÁC, đừng đọc nó):

1. Extension API thật: factory `default(pi)` nhận object có key
   `pi, extension, runtime, cwd, events, logger, typebox, arktype, zod, flagValues,
   pendingProviderRegistrations`.
   - `registerProvider` nằm ở `pi` (extension API), KHÔNG phải `pi.pi`.
   - `pi.pi` là namespace nội bộ của OMP (ModelRegistry, ExtensionRunner, …) — không dùng.
   - `pi.logger.warn(...)` là API log thật.
2. `registerProvider(name, config, sourceId?)`:
   - **`config.api` phải là tên CUSTOM.** Tên built-in (`"openai-completions"`, …) bị
     reserve → throw `ConfigurationError: Cannot register custom API "…": built-in API
     names are reserved` → **toàn bộ provider bị hủy im lặng nếu bạn nuốt exception**.
   - **`config.fetchDynamicModels` chỉ được gọi khi CÓ cả `apiKey` VÀ `baseUrl`.**
   - `config.streamSimple` bắt buộc nếu có `api` (`throw` nếu thiếu `api`).
3. `AssistantMessageEventStream` **không** được truyền cho extension. Phải tự viết.
   Xem `EventStream` trong `src/stream.js` (đủ: `push`, `end`, `[Symbol.asyncIterator]`,
   `result()`, `hasPendingLocalWork`).
4. Model selector = `<tên-provider-đã-đăng-ký>/<model.id>`. OMP tự ghép, nên `model.id`
   phải là `<providerID>/<modelID>` (KHÔNG lặp lại tên provider).
   → provider đăng ký tên `opencode-bridge` vì provider `opencode` của OpenCode trùng tên.
   → selector thực tế: `opencode-bridge/opencode/space-bunny-free`
5. `apiKey`/`baseUrl` đang đặt là placeholder public của OpenCode Zen
   (`"public"` / `https://opencode.ai/zen/v1`) chỉ để mở khoá discovery.
   Mọi request thật đi qua `streamSimple` → OpenCode, không đi qua chỗ này.
6. Kiểm tra nhanh xem provider có được đăng ký không:
   `omp models --json | grep opencode-bridge`

## Facts về OpenCode CLI (đã xác minh)

- Shim trên Windows là `opencode.cmd`. **Node ≥18.20 / Bun chặn spawn `.cmd` trực tiếp**
  (EINVAL, CVE-2024-27980) → phải route qua `cmd.exe /d /s /c`. Đã xử lý trong `run()`.
- `opencode api <operationId>` trả JSON. Dùng **operationId trần**, không dùng
  `api GET /path` (parse lỗi trên Windows).
- **`model.list`** là operation danh sách model thật, có `capabilities`, `cost`, `limit`,
  `variants` (biến thể `reasoningEffort` = model có reasoning).
- `provider.list` chỉ trả tên provider, **không có mảng `models`** — chỉ dùng fallback.
- **Không** có endpoint chat/completions kiểu OpenAI. Inference đi qua session API.
- Không scrape TUI.

## Việc còn lại (theo thứ tự)

### 1. Auth OpenCode để có model trả lời được
```
opencode auth login
```
Sau đó `omp --model opencode-bridge/opencode/<model> -p "hi"` phải ra text thật.
Hiện tại mọi model đều 401 vì chưa auth.

### 2. Xác minh `session.prompt` trả text thật — đây là phần CHƯA chắc
`src/stream.js` map sang `session.create` + `session.prompt`, nhưng **chưa từng thấy
response thành công**. Schema response chưa phải public contract; `normalizeResult()`
đang đoán nhiều shape và throw `CapabilityError` nếu không tách được text.
Việc cần làm:
- Chạy thật: `opencode api session.create -d '{}'` rồi `session.prompt` với
  `{sessionID, providerID, modelID, parts}` — xem **chính xác** response ra gì.
- Sửa `normalizeResult()` theo shape thật, bỏ các nhánh đoán không còn cần.
- Giữ nguyên nguyên tắc: không đoán sai — shape lạ thì `CapabilityError`, không trả
  rỗng.
- Kiểm tra luôn `session.abort` có thật sự cần không, và có làm hỏng gì không.

### 3. Streaming
Hiện là **buffered** (một khối text), vì session API không stream token tới bridge.
Kiểm tra xem `session.step.streamed` / `event.subscribe` có cho stream thật không
(có trong danh sách operation đã thấy). Nếu không được → giữ buffered và ghi rõ
vào README (đã ghi sẵn). Không được bịa.

### 4. Tool calling
Hiện `mapRequest` **từ chối** mọi `options.tools` bằng `CapabilityError` (đúng nguyên tắc
"không bỏ qua tham số không hỗ trợ"). Kiểm tra xem OpenCode session API có nhận tool
schema không. Nếu không → giữ nguyên từ chối, đã ghi vào README.

### 5. Reasoning/effort chạy thật
`mapRequest` gửi `reasoningEffort` khi model có reasoning. Chỉ mới verify qua unit
test với stub, chưa chạy thật với model reasoning.

### 6. Cập nhật README sau khi xác minh inference
README hiện mô tả inference là "bounded capability" — giữ nguyên tinh thần đó, nhưng
cần sửa chi tiết nếu `session.prompt` thực tế khác (ví dụ: có cần `parts` dạng khác,
có trả `usage` không, có cần `system` không).

## Nguyên tắc bắt buộc (từ spec gốc)

- Không bịa API. Mọi operation phải verify được từ `opencode api <op>` thật.
- Không hardcode danh sách model OpenCode.
- Không copy API key vào OMP. OpenCode tự quản lý auth.
- Không bao giờ log credential (đã có `src/redact.js`).
- Không bỏ qua tham số không hỗ trợ — phải báo lỗi rõ ràng.
- Không tạo sandbox giả. OMP load extension in-process, không có isolation; audit chỉ
  là cảnh báo pre-install (đã ghi trong DESIGN.md).
- Không đánh dấu xong nếu chưa test. Mọi thứ phải chạy thật với OpenCode thật.

## Lệnh hay dùng

```bash
cd /d/unknown/tool/omp
npm test                                   # 33 unit tests, không cần mạng
node src/cli.js doctor                    # detect OpenCode, version, models
opencode api model.list                   # xem model thật
omp models --json | grep opencode-bridge  # xem bridge đã đăng ký chưa
omp --model opencode-bridge/opencode/<m> -p "hi"
```

## File

- `src/opencode.js` — client: detect, `api()`, `model.list` → `mapModelList()` (chính)
- `src/stream.js` — `EventStream`, `mapRequest`, `runInference`, `normalizeResult` (⚠ chỗ cần verify)
- `src/extension.js` — đăng ký provider (đã đúng, có comment giải thích 3 yêu cầu của OMP)
- `src/doctor.js`, `src/audit.js`, `src/cli.js`, `src/redact.js` — xong, ổn
- `DESIGN.md` — kiến trúc + ranh giới bảo mật
- `test/{pure,run,stream}.test.mjs` — 33 test
