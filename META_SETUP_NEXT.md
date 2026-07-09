# Bước tiếp theo trên Meta Developer

Anh đang bị kẹt ở lỗi:

```text
Không Webhook subscription được. Vui lòng thử lại.
```

Lý do: chưa có Webhook URL được xác minh.

## Sau khi dev/server có URL

Ví dụ dev đưa anh URL:

```text
https://bot.iva.vn/webhook
```

Anh làm như sau:

1. Quay lại màn hình **Thiết lập API Messenger**.
2. Mục **1. Đặt cấu hình webhook**.
3. Nhập:

```text
URL gọi lại: https://bot.iva.vn/webhook
Xác minh mã: iva_verify_2026
```

4. Bấm **Xác minh và lưu**.
5. Kéo xuống mục **2. Tạo mã truy cập**.
6. Bấm **Thêm đăng ký**.
7. Chọn:

```text
messages
messaging_postbacks
```

8. Bấm **Confirm**.

Lúc đó lỗi đăng ký webhook sẽ hết.

## Những thứ không gửi công khai

- Page Access Token
- OpenAI API Key
- App Secret

Nếu cần gửi cho dev, gửi qua kênh riêng bảo mật.

