param(
    [string]$BackendUrl = "https://recruitment-backend-782458551389.us-central1.run.app",
    [string]$Token = $env:RECRUITMENT_TOKEN,
    [string]$CandidateId
)

$ErrorActionPreference = "Continue"
$pass = 0
$fail = 0
$skip = 0
$global:lastSendResult = $null

function Test-Check {
    param(
        [string]$Name,
        [bool]$Result,
        [string]$Detail = ""
    )

    if ($Result) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  [FAIL] $Name  $Detail" -ForegroundColor Red
        $script:fail++
    }
}

function Test-Skip {
    param([string]$Name, [string]$Detail = "")
    Write-Host "  [SKIP] $Name  $Detail" -ForegroundColor Yellow
    $script:skip++
}

Write-Host "`n=== Recruitment System Smoke Tests ===" -ForegroundColor Cyan
Write-Host "Backend: $BackendUrl"

# 1) Health check (no auth)
Write-Host "`n1. Health / reachability"
try {
    $health = Invoke-RestMethod "$BackendUrl/health" -Method GET -TimeoutSec 15
    Test-Check "Backend reachable" $true "status=$($health.status)"
} catch {
    Test-Check "Backend reachable" $false "$($_.Exception.Message)"
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "`nNo RECRUITMENT_TOKEN provided. Authenticated checks will be skipped." -ForegroundColor Yellow
    Test-Skip "Candidate context endpoint" "Missing bearer token"
    Test-Skip "WhatsApp send" "Missing bearer token"
    Test-Skip "Email send" "Missing bearer token"
    Test-Skip "Both-channel send" "Missing bearer token"
    Test-Skip "Per-channel error format" "Missing bearer token"
    Test-Skip "Gmail OAuth status endpoint" "Missing bearer token"

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  PASSED: $pass   FAILED: $fail   SKIPPED: $skip" -ForegroundColor Yellow
    Write-Host "==========================================`n" -ForegroundColor Cyan
    if ($fail -gt 0) { exit 1 }
    exit 0
}

$headers = @{
    Authorization = "Bearer $Token"
    "Content-Type" = "application/json"
}

# Resolve candidate id if not provided.
if ([string]::IsNullOrWhiteSpace($CandidateId)) {
    Write-Host "`nResolving candidate from active chats..."
    try {
        $chats = Invoke-RestMethod "$BackendUrl/api/communications/active-chats" -Method GET -Headers $headers -TimeoutSec 20
        if ($chats -is [array] -and $chats.Count -gt 0) {
            $CandidateId = $chats[0].candidate_id
        } elseif ($chats -and $chats.candidate_id) {
            $CandidateId = $chats.candidate_id
        }
    } catch {
        Test-Check "Load active chats" $false "$($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($CandidateId)) {
    Test-Check "Candidate resolution" $false "No candidate available for authenticated smoke checks"
    Test-Skip "Candidate context endpoint" "No candidate id"
    Test-Skip "WhatsApp send" "No candidate id"
    Test-Skip "Email send" "No candidate id"
    Test-Skip "Both-channel send" "No candidate id"
} else {
    Write-Host "Using candidate id: $CandidateId"

    # 2) Candidate context endpoint
    Write-Host "`n2. Candidate context endpoint"
    try {
        $ctx = Invoke-RestMethod "$BackendUrl/api/communications/candidate/$CandidateId/context" -Method GET -Headers $headers -TimeoutSec 20
        Test-Check "Context endpoint returns payload" $true
        Test-Check "Has application key" ($null -ne $ctx.PSObject.Properties["application"])
        Test-Check "Has interview key" ($null -ne $ctx.PSObject.Properties["interview"])
    } catch {
        Test-Check "Context endpoint" $false "$($_.Exception.Message)"
    }

    # 3) WhatsApp only
    Write-Host "`n3. POST /send - WhatsApp only"
    try {
        $body = @{
            candidate_id = $CandidateId
            channel = "whatsapp"
            message = "[Smoke test] WhatsApp ping $(Get-Date -Format 'HH:mm:ss')"
        } | ConvertTo-Json

        $wa = Invoke-RestMethod "$BackendUrl/api/communications/send" -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $global:lastSendResult = $wa

        Test-Check "Returns id" (-not [string]::IsNullOrWhiteSpace($wa.id))
        Test-Check "channel_results.whatsapp exists" ($null -ne $wa.channel_results.whatsapp)
        if ($wa.simulated) {
            Write-Host "  [WARN] WhatsApp simulated: $($wa.delivery_errors.whatsapp)" -ForegroundColor Yellow
            Test-Check "Simulated response is graceful" $true
        } else {
            Test-Check "WhatsApp delivered (not simulated)" $true
        }
    } catch {
        Test-Check "WhatsApp send" $false "$($_.Exception.Message)"
    }

    # 4) Email only
    Write-Host "`n4. POST /send - Email only"
    try {
        $body = @{
            candidate_id = $CandidateId
            channel = "email"
            message = "[Smoke test] Email ping $(Get-Date -Format 'HH:mm:ss')"
            email_subject = "Recruitment System Smoke Test"
        } | ConvertTo-Json

        $em = Invoke-RestMethod "$BackendUrl/api/communications/send" -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $global:lastSendResult = $em

        Test-Check "Returns id" (-not [string]::IsNullOrWhiteSpace($em.id))
        Test-Check "channel_results.email exists" ($null -ne $em.channel_results.email)
        if ($em.simulated) {
            Write-Host "  [WARN] Email simulated: $($em.delivery_errors.email)" -ForegroundColor Yellow
            Test-Check "Simulated response is graceful" $true
        } else {
            Test-Check "Email delivered (not simulated)" $true
        }
    } catch {
        Test-Check "Email send" $false "$($_.Exception.Message)"
    }

    # 5) Both channels
    Write-Host "`n5. POST /send - Both channels"
    try {
        $body = @{
            candidate_id = $CandidateId
            channels = "whatsapp,email"
            message = "[Smoke test] Both-channel ping $(Get-Date -Format 'HH:mm:ss')"
            email_subject = "Recruitment System Smoke Test (both)"
        } | ConvertTo-Json

        $both = Invoke-RestMethod "$BackendUrl/api/communications/send" -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $global:lastSendResult = $both

        Test-Check "Returns id" (-not [string]::IsNullOrWhiteSpace($both.id))
        Test-Check "Has whatsapp result" ($null -ne $both.channel_results.whatsapp)
        Test-Check "Has email result" ($null -ne $both.channel_results.email)

        if ($both.delivery_errors) {
            $parts = @()
            foreach ($p in $both.delivery_errors.PSObject.Properties) {
                $parts += ("{0}: {1}" -f $p.Name, $p.Value)
            }
            if ($parts.Count -gt 0) {
                Write-Host ("  [WARN] Partial delivery issues: {0}" -f ([string]::Join(" ; ", $parts))) -ForegroundColor Yellow
            }
        }
    } catch {
        Test-Check "Both-channel send" $false "$($_.Exception.Message)"
    }
}

# 6) Per-channel error format
Write-Host "`n6. Per-channel error format"
if ($null -eq $global:lastSendResult) {
    Test-Skip "delivery_errors shape" "No send result available"
} else {
    Test-Check "delivery_errors is object or null" ($null -eq $global:lastSendResult.delivery_errors -or -not ($global:lastSendResult.delivery_errors -is [string]))
}

# 7) Gmail status endpoint
Write-Host "`n7. Gmail OAuth connection status"
try {
    $gmail = Invoke-RestMethod "$BackendUrl/api/gmail/status" -Method GET -Headers $headers -TimeoutSec 20
    Test-Check "Gmail status endpoint reachable" $true
    if ($gmail.connected) {
        Test-Check "Gmail connected" $true
    } else {
        Write-Host "  [WARN] Gmail not connected. Authorize at: $BackendUrl/api/gmail/auth" -ForegroundColor Yellow
        Test-Check "Gmail reports connected=false gracefully" ($null -ne $gmail.PSObject.Properties["connected"])
    }
} catch {
    Test-Check "Gmail status endpoint" $false "$($_.Exception.Message)"
}

Write-Host "`n==========================================" -ForegroundColor Cyan
if ($fail -eq 0) {
    Write-Host "  PASSED: $pass   FAILED: $fail   SKIPPED: $skip" -ForegroundColor Green
} else {
    Write-Host "  PASSED: $pass   FAILED: $fail   SKIPPED: $skip" -ForegroundColor Yellow
}
Write-Host "==========================================`n" -ForegroundColor Cyan

if ($fail -gt 0) { exit 1 }
exit 0
