# Meta WhatsApp Production Go-Live (Dewan Chatbot)

This runbook switches the chatbot to a production Meta app + real WhatsApp number with a permanent System User token.

## 1) Prepare Business Assets (Meta)

1. Open Meta Business Manager -> **Business Settings**.
2. Confirm these assets are under the same business:
   - WhatsApp Business Account (WABA)
   - Production phone number
   - Meta App (the app you will use for webhook + API)
3. Add payment method in WhatsApp Manager (required for business-initiated conversations).
4. Keep current messaging tier at 250 business-initiated conversations / 24h.

## 2) Create Permanent Token (System User)

1. Business Settings -> **Users** -> **System users** -> **Add**.
2. Create Admin system user (example: `dewan-chatbot-prod`).
3. Assign assets to this system user:
   - Meta app
   - WABA / phone number assets
4. Click **Generate new token** for the selected app.
5. Include permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
   - `business_management` (only if needed)
6. Copy and store token in your secret manager.

## 3) Update Environment Values

Update your runtime environment (Cloud Run env + local `.env`) with the same production values:

- `META_ACCESS_TOKEN` = System User permanent token
- `META_WHATSAPP_BUSINESS_ACCOUNT_ID` = Production WABA ID
- `META_PHONE_NUMBER_ID` = Production phone number ID
- `META_APP_SECRET` = Meta App Secret
- `META_VERIFY_TOKEN` = Strong random secret (not a default string)
- `META_API_VERSION` = `v18.0` (keep current unless upgrading code + API together)
- `CLOUD_RUN_URL` = `https://whatsapp-chatbot-782458551389.us-central1.run.app`

Callback URL to set in Meta:

`https://whatsapp-chatbot-782458551389.us-central1.run.app/webhook/whatsapp`

## 4) Configure Webhook in Meta Developers

1. Go to Meta Developers -> your app -> WhatsApp -> **Configuration**.
2. Set **Callback URL**:
   - `https://whatsapp-chatbot-782458551389.us-central1.run.app/webhook/whatsapp`
3. Set **Verify token** exactly as `META_VERIFY_TOKEN`.
4. Click **Verify and save**.
5. Subscribe webhook fields:
   - `messages` (required)
   - `message_status` (optional but recommended)
6. Set app mode to **Live**.

## 5) Run Preflight Script

From `Chatbot/whatsapp-recruitment-bot`:

```powershell
python scripts/meta_preflight.py
```

If your callback URL is not public yet:

```powershell
python scripts/meta_preflight.py --skip-webhook
```

The script validates:

- Graph API access to phone number ID
- Graph API access to WABA ID
- Webhook challenge response from `/webhook/whatsapp`

## 6) Smoke Test (Required)

1. Send a message from real handset to production WhatsApp number.
2. Confirm chatbot replies.
3. Complete one candidate flow.
4. Confirm backend intake success at `POST /api/chatbot/intake`.
5. Confirm health endpoints:
   - Chatbot: `/health`
   - Recruitment backend: `/health`

## 7) Stabilization (First 48 Hours)

Monitor logs for:

- `401/403` Graph API auth errors (token/permissions)
- `400` message send payload errors
- Webhook signature mismatch (if app secret enabled)
- Database connection failures

Rollback plan:

1. Revert Cloud Run env variables to previous known-good values.
2. Redeploy service.
3. Re-run preflight and smoke tests.

## 8) Security Notes

- Never commit real `.env` to git.
- Rotate `META_VERIFY_TOKEN` and `CHATBOT_API_KEY` periodically.
- Keep `META_APP_SECRET` populated in production to enforce signature verification.