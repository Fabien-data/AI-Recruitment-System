$BASE = "https://recruitment-backend-782458551389.us-central1.run.app"
$loginResp = Invoke-RestMethod -Uri "$BASE/api/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"admin@recruitment.com","password":"admin123"}'
$H = @{"Authorization"="Bearer $($loginResp.token)"}

$projs = (Invoke-RestMethod -Uri "$BASE/api/projects?limit=50" -Headers $H).data
Write-Host "Found $($projs.Count) projects"

# IDs created by seed-cloud-db.ps1 (have jobs attached)
$keepIds = @(
  "7dace2da-83e8-44eb-b347-7cb284bcca3f",
  "42ca644b-aa1b-4910-8c39-e72c58eda495",
  "9c6fb00e-eed7-4842-a1d1-60f5734fcc24",
  "5e857647-8669-4a3a-ae8c-75855179a854",
  "8d2d5aec-4717-4ce6-b674-ca6c91486482",
  "b7e1a3a8-c97b-4648-b402-fa6445e79661",
  "f7a3ea9d-21ef-4bb3-bd7d-a3cda6962e3d"
)

$deleteCount = 0
foreach ($p in $projs) {
  if ($keepIds -notcontains $p.id) {
    try {
      Invoke-RestMethod -Uri "$BASE/api/projects/$($p.id)" -Method DELETE -Headers $H | Out-Null
      Write-Host "Deleted: $($p.title) ($($p.id))"
      $deleteCount++
    } catch { Write-Host "ERR deleting $($p.title): $_" }
  }
}

$remaining = (Invoke-RestMethod -Uri "$BASE/api/projects?limit=50" -Headers $H).data.Count
Write-Host "Deleted $deleteCount duplicates. Remaining: $remaining projects"
