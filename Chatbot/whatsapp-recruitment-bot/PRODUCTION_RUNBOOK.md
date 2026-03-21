# WhatsApp Chatbot Production Runbook (GCP)

This runbook is verified for:
- **Project:** `dewan-chatbot-1234`
- **Region:** `us-central1`
- **App Service:** `whatsapp-chatbot`
- **Worker Service:** `whatsapp-celery-worker`

---

## 0) Open terminal in project

```powershell
Set-Location "D:\Dewan Project\Chatbot\whatsapp-recruitment-bot"
```

---

## 1) Configure gcloud context

```powershell
gcloud config set project dewan-chatbot-1234
gcloud config set run/region us-central1
gcloud auth list
```

---

## 2) Enable required APIs

```powershell
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  redis.googleapis.com `
  sqladmin.googleapis.com `
  secretmanager.googleapis.com `
  vpcaccess.googleapis.com `
  compute.googleapis.com `
  --project dewan-chatbot-1234 --quiet
```

---

## 3) Create networking + Redis (one-time)

```powershell
gcloud compute networks vpc-access connectors create chatbot-connector `
  --region us-central1 `
  --network default `
  --range 10.8.0.0/28 `
  --project dewan-chatbot-1234

# If connector already exists, continue.
```

```powershell
gcloud redis instances create chatbot-redis `
  --size=1 `
  --region=us-central1 `
  --redis-version=redis_7_0 `
  --network=default `
  --tier=basic `
  --project dewan-chatbot-1234

# If instance already exists, continue.
```

Get Redis endpoint:

```powershell
gcloud redis instances describe chatbot-redis `
  --region us-central1 `
  --project dewan-chatbot-1234 `
  --format="value(host,port)"
```

Expected current value:
- `10.232.182.75 6379`

Set `REDIS_URL` in `env.yaml` to:
- `redis://10.232.182.75:6379/0`

---

## 4) Ensure worker startup script exists

File: `scripts/run_worker.sh`

```sh
#!/bin/sh
set -e

python -m http.server "${PORT:-8080}" &
exec celery -A app.celery_app worker --pool=gevent --concurrency=100 --loglevel=info
```

---

## 5) Build and push Docker image

```powershell
$PROJECT="dewan-chatbot-1234"
$REGION="us-central1"
$TAG=(Get-Date -Format "yyyyMMdd-HHmmss")
$IMAGE="$REGION-docker.pkg.dev/$PROJECT/chatbot/whatsapp-chatbot:$TAG"

# Create Artifact Registry repo once (safe to re-run)
gcloud artifacts repositories create chatbot `
  --repository-format=docker `
  --location=$REGION `
  --project=$PROJECT `
  --description="Chatbot images" --quiet

# Build + push
gcloud builds submit --tag $IMAGE --project=$PROJECT --timeout=3600 .

Write-Output "IMAGE=$IMAGE"
```

---

## 6) Deploy FastAPI app service

```powershell
gcloud run deploy whatsapp-chatbot `
  --project dewan-chatbot-1234 `
  --region us-central1 `
  --image $IMAGE `
  --allow-unauthenticated `
  --env-vars-file env.yaml `
  --add-cloudsql-instances "dewan-chatbot-1234:us-central1:recruitment-db" `
  --vpc-connector chatbot-connector `
  --vpc-egress private-ranges-only `
  --min-instances 1 `
  --max-instances 20 `
  --quiet
```

---

## 7) Deploy Celery worker service

```powershell
gcloud run deploy whatsapp-celery-worker `
  --project dewan-chatbot-1234 `
  --region us-central1 `
  --image $IMAGE `
  --no-allow-unauthenticated `
  --ingress internal `
  --env-vars-file env.yaml `
  --add-cloudsql-instances "dewan-chatbot-1234:us-central1:recruitment-db" `
  --vpc-connector chatbot-connector `
  --vpc-egress private-ranges-only `
  --min-instances 1 `
  --max-instances 3 `
  --port 8080 `
  --command sh `
  --args /app/scripts/run_worker.sh `
  --quiet
```

---

## 8) Post-deploy verification

FastAPI health:

```powershell
Invoke-WebRequest -Uri "https://whatsapp-chatbot-782458551389.us-central1.run.app/health" -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

Worker logs (must show Celery connected to Redis):

```powershell
gcloud run services logs read whatsapp-celery-worker `
  --region us-central1 `
  --project dewan-chatbot-1234 `
  --limit 80
```

Look for lines like:
- `Connected to redis://10.232.182.75:6379/0`
- `app.tasks.process_webhook_task`

Service details:

```powershell
gcloud run services describe whatsapp-chatbot --region us-central1 --project dewan-chatbot-1234 --format="value(status.url,spec.template.spec.containers[0].image)"
gcloud run services describe whatsapp-celery-worker --region us-central1 --project dewan-chatbot-1234 --format="value(status.url,spec.template.spec.containers[0].image,spec.template.spec.containers[0].command,spec.template.spec.containers[0].args)"
```

---

## 9) Rollback (if needed)

List revisions:

```powershell
gcloud run revisions list --service whatsapp-chatbot --region us-central1 --project dewan-chatbot-1234
```

Route traffic to a previous revision:

```powershell
gcloud run services update-traffic whatsapp-chatbot `
  --region us-central1 `
  --project dewan-chatbot-1234 `
  --to-revisions REVISION_NAME=100
```

---

## 10) Security cleanup (strongly recommended)

- Rotate exposed API keys/tokens/passwords (Meta, OpenAI, DB, chatbot API key).
- Move secrets to Secret Manager and switch Cloud Run to `--set-secrets`.
- Keep `env.yaml` with placeholders only (no raw secrets in repo/workspace).
