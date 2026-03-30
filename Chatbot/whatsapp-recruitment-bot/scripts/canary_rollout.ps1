Param(
    [string]$Project = "dewan-chatbot-1234",
    [string]$Region = "us-central1",
    [string]$Service = "whatsapp-chatbot",
    [int]$CanaryPercent = 10
)

Write-Host "[canary] Starting staged rollout checks" -ForegroundColor Cyan

Write-Host "[canary] Step 1: Run release gate" -ForegroundColor Yellow
python scripts/release_gate.py
if ($LASTEXITCODE -ne 0) {
    throw "Release gate failed"
}

Write-Host "[canary] Step 2: Deploy with modular orchestrator disabled" -ForegroundColor Yellow
# Example command template; adapt env vars file as needed.
# gcloud run services update $Service --project $Project --region $Region --update-env-vars ENABLE_MODULAR_ORCHESTRATOR=false

Write-Host "[canary] Step 3: Route $CanaryPercent% traffic to latest revision" -ForegroundColor Yellow
# gcloud run services update-traffic $Service --project $Project --region $Region --to-latest $CanaryPercent

Write-Host "[canary] Step 4: Observe logs and error rate before increasing traffic" -ForegroundColor Yellow
Write-Host "[canary] Suggested checks:" -ForegroundColor Gray
Write-Host "  - webhook latency p95 < 2s" -ForegroundColor Gray
Write-Host "  - 5xx error rate < 1%" -ForegroundColor Gray
Write-Host "  - handoff spike not exceeding baseline" -ForegroundColor Gray

Write-Host "[canary] Step 4a: Fetch Cloud Run canary metrics" -ForegroundColor Yellow
python scripts/fetch_cloudrun_metrics.py --project $Project --service $Service --region $Region --output canary_metrics.json
if ($LASTEXITCODE -ne 0) {
    throw "Canary metrics check failed"
}

Write-Host "[canary] Step 4b: Run multilingual UAT and generate go-live report" -ForegroundColor Yellow
python scripts/run_multilingual_uat.py --output uat_report.json
if ($LASTEXITCODE -ne 0) {
    throw "Multilingual UAT failed"
}
python scripts/generate_go_live_report.py --release-gate-passed --canary-metrics canary_metrics.json --uat-report uat_report.json
if ($LASTEXITCODE -ne 0) {
    throw "Go-live report produced NO-GO"
}

Write-Host "[canary] Step 5: Ramp to 25%, 50%, then 100% after 24h stability" -ForegroundColor Yellow
Write-Host "[canary] NOTE: deployment/traffic commands are templates and remain commented until you explicitly enable them." -ForegroundColor Gray
Write-Host "[canary] Complete" -ForegroundColor Green
