$PROJECT="dewan-chatbot-1234"
$REGION="us-central1"
$TAG=(Get-Date -Format "yyyyMMdd-HHmmss")
$IMAGE="$REGION-docker.pkg.dev/$PROJECT/chatbot/whatsapp-chatbot:$TAG"

Write-Output "Building image: $IMAGE"
gcloud builds submit --tag $IMAGE --project=$PROJECT --timeout=3600 .

if ($?) {
  Write-Output "Deploying whatsapp-chatbot..."
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

  Write-Output "Deploying whatsapp-celery-worker..."
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
} else {
  Write-Output "Build failed. Skipping deployment."
}
gcloud run services describe whatsapp-chatbot --region us-central1 --project dewan-chatbot-1234 --format="value(status.url)"
