# Hướng dẫn đưa IVA Chatpage Bot lên server

Tài liệu này dành cho kỹ thuật/dev triển khai bot để lấy URL webhook nhập vào Meta Developer.

## 1. Yêu cầu server

- Node.js 20 trở lên.
- Server chạy 24/7.
- Có HTTPS public domain, ví dụ:

```text
https://bot.iva.vn
```

Webhook sau khi deploy sẽ là:

```text
https://bot.iva.vn/webhook
```

## 2. Biến môi trường cần cấu hình

Tạo các biến sau trên server:

```env
PORT=3000
VERIFY_TOKEN=iva_verify_2026
PAGE_ACCESS_TOKEN=PAGE_ACCESS_TOKEN_TU_META
GRAPH_API_VERSION=v23.0
OPENAI_API_KEY=OPENAI_API_KEY
OPENAI_MODEL=gpt-4.1-mini
MIN_REPLY_DELAY_MS=2500
MAX_REPLY_DELAY_MS=6500
```

Tuyệt đối không commit file `.env` chứa token thật.

## 3. Chạy app

```bash
cd iva-chatpage-bot
node --env-file=.env server.mjs
```

Kiểm tra server:

```text
GET https://bot.iva.vn/
```

Kết quả đúng:

```json
{
  "ok": true,
  "service": "IVA Chatpage Bot",
  "webhook": "/webhook"
}
```

## 4. Cấu hình Meta Developer

Vào app IVA trên Meta Developer:

1. Vào **Cài đặt API Messenger**.
2. Ở mục **Đặt cấu hình webhook**, nhập:

```text
URL gọi lại: https://bot.iva.vn/webhook
Xác minh mã: iva_verify_2026
```

3. Bấm **Xác minh và lưu**.
4. Ở mục Page đã kết nối, bấm **Thêm đăng ký**.
5. Chọn:

```text
messages
messaging_postbacks
```

6. Bấm **Confirm**.

## 5. Test

Nhắn thử vào Fanpage:

```text
đau lưng
```

Bot nên hỏi:

```text
Dạ tình trạng đau lưng của mình kéo dài lâu chưa ạ?
```

Nếu khách hỏi thông tin chưa có trong kịch bản, bot sẽ không trả lời để nhân sự vào tiếp quản.

## 6. Ghi log và tiếp quản

Hiện bản này ghi log ra console:

- lỗi OpenAI
- lỗi Facebook Graph API
- trường hợp handoff im lặng

Khi chạy thật nên nối log vào hệ thống quản trị hoặc CRM để nhân sự xem danh sách khách cần tiếp quản.

