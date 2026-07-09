# IVA Chatpage Bot

Bộ webhook kết nối Fanpage Facebook với AI tư vấn cho Phòng khám Phục hồi chức năng IVA.

## Bot làm gì

- Nhận tin nhắn khách từ Facebook Messenger.
- Gọi OpenAI để trả lời theo kịch bản IVA.
- Hỏi ngắn, không hỏi lan man.
- Phân loại khách theo triệu chứng hoặc bệnh lý đã biết.
- Chỉ báo ưu đãi sau khi đã nắm tình trạng và khách hỏi phí.
- Gặp thông tin chưa được cấp thì dừng im lặng để nhân sự tiếp quản.
- Tạo độ trễ trả lời tự nhiên để không giống bot.

## Cần chuẩn bị

1. Page Access Token từ Meta Developer.
2. OpenAI API key.
3. Server có HTTPS để chạy 24/7.
4. Verify Token tự đặt, ví dụ: `iva_verify_2026`.

## Cách chạy thử trên máy

```bash
cd iva-chatpage-bot
copy .env.example .env
```

Điền các biến trong file `.env`:

```env
VERIFY_TOKEN=iva_verify_2026
PAGE_ACCESS_TOKEN=...
OPENAI_API_KEY=...
```

Chạy:

```bash
node --env-file=.env server.mjs
```

Nếu chạy ổn sẽ thấy:

```text
IVA Chatpage Bot running on port 3000
Webhook path: /webhook
```

## Nhập vào Meta Developer

Khi đã đưa code lên server, anh sẽ có URL dạng:

```text
https://ten-mien-cua-anh.com/webhook
```

Trong Meta Developer nhập:

- URL gọi lại: `https://ten-mien-cua-anh.com/webhook`
- Xác minh mã: `iva_verify_2026`

Sau khi xác minh thành công, vào phần đăng ký webhook chọn:

- `messages`
- `messaging_postbacks`

## Lưu ý vận hành

- Không gửi Page Access Token hoặc OpenAI API key lên chat công khai.
- Nếu chạy trên máy cá nhân, tắt máy là bot dừng.
- Muốn chạy thật thì phải đưa lên server/cloud.
- Khi khách hỏi thông tin chưa có trong kịch bản, bot sẽ không trả lời để nhân sự vào tiếp quản.

## Cấu trúc file

- `server.mjs`: webhook nhận/gửi tin Facebook và gọi OpenAI.
- `iva_rules.mjs`: toàn bộ luật chatpage IVA.
- `.env.example`: mẫu cấu hình bảo mật.

