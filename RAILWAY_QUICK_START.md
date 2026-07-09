# Làm nhanh bằng Railway

## Anh cần chuẩn bị

1. Page Access Token từ Meta.
2. OpenAI API Key.
3. Tài khoản Railway: https://railway.com

## Các biến cần nhập vào Railway

```env
VERIFY_TOKEN=iva_verify_2026
PAGE_ACCESS_TOKEN=token_facebook_cua_anh
OPENAI_API_KEY=key_openai_cua_anh
OPENAI_MODEL=gpt-4.1-mini
MIN_REPLY_DELAY_MS=2500
MAX_REPLY_DELAY_MS=6500
```

## Lệnh chạy

Railway sẽ tự đọc file `package.json`.

Start command:

```bash
npm start
```

## Link cần lấy

Sau khi deploy xong, Railway sẽ cho link dạng:

```text
https://ten-app.up.railway.app
```

Webhook nhập vào Meta là:

```text
https://ten-app.up.railway.app/webhook
```

Verify token nhập vào Meta:

```text
iva_verify_2026
```

