# Seed Cloud SQL Database - Full Data Population
$BASE = "https://recruitment-backend-782458551389.us-central1.run.app"

# Fresh login
$loginResp = Invoke-RestMethod -Uri "$BASE/api/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"admin@recruitment.com","password":"admin123"}'
$t = $loginResp.token
$H = @{"Authorization"="Bearer $t"}
Write-Host "Logged in OK"

# =====================================================
# STEP 1: CREATE 6 PROJECTS
# =====================================================
Write-Host "`n=== CREATING PROJECTS ==="

$projects = @(
  @{
    title="Dubai Mall Security Operations"; client_name="Emaar Properties"; industry_type="Security Services"
    description="Comprehensive security services for Dubai Mall including patrol, surveillance, and customer assistance."
    countries=@("United Arab Emirates"); status="active"; priority="high"; total_positions=25; filled_positions=8
    start_date="2024-03-15"; interview_date="2024-02-28"; end_date="2025-03-15"
    benefits=@{health_insurance=$true;accommodation=$true;transportation="company_bus";annual_leave="30_days"}
    salary_info=@{base_salary=3200;currency="AED";payment_frequency="monthly"}
    contact_info=@{primary_contact="Ahmed Al-Mansouri";email="ahmed.mansouri@emaar.com";phone="+971-4-362-7777"}
    requirements=@{min_height=170;max_height=190;required_languages=@("English","Arabic");min_age=21;max_age=45;experience_years=2}
  },
  @{
    title="Qatar Luxury Hotel Operations"; client_name="Marriott International Qatar"; industry_type="Hospitality"
    description="Hospitality staff positions for 5-star hotel: front desk, housekeeping, F&B service, and guest relations."
    countries=@("Qatar"); status="active"; priority="high"; total_positions=40; filled_positions=15
    start_date="2024-04-01"; interview_date="2024-03-10"; end_date="2025-04-01"
    benefits=@{health_insurance=$true;accommodation=$true;meals="provided";annual_leave="28_days"}
    salary_info=@{base_salary=2800;currency="QAR";payment_frequency="monthly"}
    contact_info=@{primary_contact="Sarah Johnson";email="sarah.johnson@marriott.com";phone="+974-4000-8000"}
    requirements=@{min_height=160;required_languages=@("English");min_age=21;max_age=40;experience_years=1}
  },
  @{
    title="Saudi Vision 2030 Manufacturing"; client_name="SABIC Industrial Solutions"; industry_type="Manufacturing"
    description="Manufacturing and production line positions for petrochemical facility. Machine operators, QC inspectors, and supervisors."
    countries=@("Saudi Arabia"); status="active"; priority="medium"; total_positions=60; filled_positions=22
    start_date="2024-05-01"; interview_date="2024-04-15"; end_date="2026-05-01"
    benefits=@{health_insurance=$true;accommodation=$true;transportation="company_transport";annual_leave="30_days"}
    salary_info=@{base_salary=2500;currency="SAR";payment_frequency="monthly";shift_allowance=500}
    contact_info=@{primary_contact="Mohammad Al-Rashid";email="mohammad.rashid@sabic.com";phone="+966-13-321-0000"}
    requirements=@{required_languages=@("English");min_age=21;max_age=45;experience_years=1}
  },
  @{
    title="Kuwait Healthcare Support Services"; client_name="Al-Sabah Medical District"; industry_type="Healthcare"
    description="Healthcare support positions: patient care assistants, medical equipment technicians, and facility maintenance."
    countries=@("Kuwait"); status="pending"; priority="high"; total_positions=35; filled_positions=0
    start_date="2024-06-01"; interview_date="2024-05-15"; end_date="2025-06-01"
    benefits=@{health_insurance=$true;accommodation=$true;meals="subsidized";annual_leave="35_days"}
    salary_info=@{base_salary=400;currency="KWD";payment_frequency="monthly"}
    contact_info=@{primary_contact="Dr. Fatima Al-Zahra";email="fatima.alzahra@sabahmedical.kw";phone="+965-2481-7777"}
    requirements=@{required_languages=@("English","Arabic");min_age=22;max_age=50;experience_years=1}
  },
  @{
    title="Oman Tourism & Hospitality Development"; client_name="Omran Group"; industry_type="Tourism"
    description="Tourism and hospitality positions for new resort development: tour guides, hotel staff, guest experience coordinators."
    countries=@("Oman"); status="planning"; priority="medium"; total_positions=45; filled_positions=0
    start_date="2024-07-01"; interview_date="2024-06-10"; end_date="2026-07-01"
    benefits=@{health_insurance=$true;accommodation=$true;meals="provided";annual_leave="30_days"}
    salary_info=@{base_salary=500;currency="OMR";payment_frequency="monthly"}
    contact_info=@{primary_contact="Hassan Al-Baluchi";email="hassan.baluchi@omran.om";phone="+968-24-123456"}
    requirements=@{required_languages=@("English");min_age=21;max_age=40;experience_years=1}
  },
  @{
    title="Bahrain Financial District Operations"; client_name="Bahrain World Trade Center"; industry_type="Corporate Services"
    description="Corporate support services: office administration, security, cleaning, and maintenance for premium office buildings."
    countries=@("Bahrain"); status="active"; priority="low"; total_positions=30; filled_positions=18
    start_date="2024-03-01"; interview_date="2024-02-15"; end_date="2025-03-01"
    benefits=@{health_insurance=$true;transportation="allowance";annual_leave="25_days"}
    salary_info=@{base_salary=350;currency="BHD";payment_frequency="monthly"}
    contact_info=@{primary_contact="Amira Al-Khalifa";email="amira.khalifa@bwtc.bh";phone="+973-1721-1111"}
    requirements=@{required_languages=@("English");min_age=21;max_age=45}
  }
)

$projectIds = @()
foreach ($p in $projects) {
  $body = $p | ConvertTo-Json -Depth 5
  try {
    $resp = Invoke-RestMethod -Uri "$BASE/api/projects" -Method POST -Headers $H -ContentType "application/json" -Body $body
    Write-Host "  OK: $($p.title) -> $($resp.id)"
    $projectIds += $resp.id
  } catch {
    Write-Host "  ERR: $($p.title) -> $_"
  }
}
# Also include the already-created project
$projectIds += "f7a3ea9d-21ef-4bb3-bd7d-a3cda6962e3d"
Write-Host "Total project IDs: $($projectIds.Count)"

# =====================================================
# STEP 2: CREATE 5 JOBS PER PROJECT
# =====================================================
Write-Host "`n=== CREATING JOBS (5 per project) ==="

$jobTemplates = @(
  @{ title="Security Operator"; category="security"; description="Security guard position for site patrol and access control."; requirements=@{min_height_cm=170;max_height_cm=190;required_languages=@("English");min_age=21;max_age=45;experience_years=1;specific_info_to_ask=@("Height","Age","Arms Handling Experience")}; wiggle_room=@{height_tolerance_cm=5;age_tolerance_years=2}; positions_available=5; salary_range="800-1200 AED/month"; location="GCC"; status="active" },
  @{ title="CCTV Operator"; category="security"; description="CCTV operator for surveillance and monitoring."; requirements=@{required_languages=@("English");min_age=21;max_age=40;experience_years=2;specific_info_to_ask=@("CCTV License","Age","Surveillance Software Experience")}; wiggle_room=@{experience_tolerance_years=1}; positions_available=3; salary_range="900-1400 AED/month"; location="GCC"; status="active" },
  @{ title="Hospitality Assistant"; category="hospitality"; description="Hotel or restaurant staff: front desk, housekeeping, or F&B."; requirements=@{required_languages=@("English");min_age=21;max_age=45;experience_years=0;specific_info_to_ask=@("Height","Age","Hospitality Training Level")}; wiggle_room=@{age_tolerance_years=3}; positions_available=10; salary_range="600-900 AED/month"; location="GCC"; status="active" },
  @{ title="VIP Bodyguard"; category="security"; description="Close protection operative for VIP physical security."; requirements=@{required_languages=@("English","Arabic");min_age=25;max_age=50;experience_years=3;specific_info_to_ask=@("Height","Age","Martial Arts Expertise","Arms Handling Experience")}; wiggle_room=@{experience_tolerance_years=1;age_tolerance_years=2}; positions_available=5; salary_range="2500-4000 AED/month"; location="GCC"; status="active" },
  @{ title="Duty Patrol Driver"; category="logistics"; description="Patrol driver role for security rounds."; requirements=@{required_languages=@("English");min_age=23;max_age=45;experience_years=2;licenses=@("driving_license");specific_info_to_ask=@("Driving License Type","Years of GCC Driving Experience","Age")}; wiggle_room=@{age_tolerance_years=2}; positions_available=3; salary_range="1000-1500 AED/month"; location="GCC"; status="active" }
)

$allJobIds = @()
# Also add the existing job
$allJobIds += "91652c64-6d35-4264-8e25-bfdf493f94d9"

foreach ($prjId in $projectIds) {
  foreach ($tmpl in $jobTemplates) {
    $jobBody = @{
      title         = $tmpl.title
      category      = $tmpl.category
      description   = $tmpl.description
      requirements  = $tmpl.requirements
      wiggle_room   = $tmpl.wiggle_room
      positions_available = $tmpl.positions_available
      salary_range  = $tmpl.salary_range
      location      = $tmpl.location
      status        = $tmpl.status
      project_id    = $prjId
    } | ConvertTo-Json -Depth 5
    try {
      $jr = Invoke-RestMethod -Uri "$BASE/api/jobs" -Method POST -Headers $H -ContentType "application/json" -Body $jobBody
      $allJobIds += $jr.id
    } catch {
      Write-Host "  Job ERR: $($tmpl.title) for $prjId -> $_"
    }
  }
  Write-Host "  Added 5 jobs for project $prjId"
}
Write-Host "Total jobs created: $($allJobIds.Count)"

# =====================================================
# STEP 3: GET CANDIDATE IDs + CREATE APPLICATIONS
# =====================================================
Write-Host "`n=== CREATING APPLICATIONS ==="

$candResp = Invoke-RestMethod -Uri "$BASE/api/candidates?limit=50" -Headers $H
$candidates = $candResp.data
Write-Host "Found $($candidates.Count) candidates"

$appStatuses = @("applied","screening","certified","interview_scheduled","selected","rejected")
$appCount = 0

for ($i = 0; $i -lt $candidates.Count; $i++) {
  $cand = $candidates[$i]
  # Assign each candidate to 3 random jobs
  $selectedJobs = $allJobIds | Get-Random -Count 3
  $statusIdx = 0
  foreach ($jobId in $selectedJobs) {
    if (-not $jobId) { continue }
    $appBody = @{
      candidate_id = $cand.id
      job_id       = $jobId
      status       = $appStatuses[$statusIdx % $appStatuses.Count]
      match_score  = [math]::Round((Get-Random -Minimum 40 -Maximum 99) / 100, 2)
    } | ConvertTo-Json
    try {
      Invoke-RestMethod -Uri "$BASE/api/applications" -Method POST -Headers $H -ContentType "application/json" -Body $appBody | Out-Null
      $appCount++
    } catch { }
    $statusIdx++
  }
  Write-Host "  Applied $($cand.name) to 3 jobs"
}
Write-Host "Total applications created: $appCount"

# =====================================================
# STEP 4: SEED COMMUNICATIONS HISTORY
# =====================================================
Write-Host "`n=== CREATING COMMUNICATIONS ==="

$channels = @("whatsapp","email","whatsapp","whatsapp","sms")
$directions = @("inbound","outbound")
$messages = @(
  "Hello, I am interested in the security guard position. Can you provide more details?",
  "Thank you for your application. We would like to invite you for a screening interview.",
  "I have attached my CV for your review. I have 5 years of experience.",
  "Your application has been reviewed. Please confirm your availability for an interview.",
  "I am available Monday to Friday, 9am to 5pm for an interview.",
  "Congratulations! You have been shortlisted. Please bring original documents.",
  "What is the salary package for the Dubai Mall position?",
  "The salary ranges from 3000-3500 AED per month including accommodation.",
  "I have a security license and first aid certification.",
  "Please send us copies of your certifications for verification."
)

$commCount = 0
foreach ($cand in $candidates) {
  $numMessages = Get-Random -Minimum 2 -Maximum 5
  for ($m = 0; $m -lt $numMessages; $m++) {
    $commBody = @{
      candidate_id = $cand.id
      channel      = $channels[$m % $channels.Count]
      direction    = $directions[$m % 2]
      message_type = "text"
      content      = $messages[($commCount + $m) % $messages.Count]
    } | ConvertTo-Json
    try {
      Invoke-RestMethod -Uri "$BASE/api/communications" -Method POST -Headers $H -ContentType "application/json" -Body $commBody | Out-Null
      $commCount++
    } catch { }
  }
  Write-Host "  Communications added for $($cand.name)"
}
Write-Host "Total communications created: $commCount"

Write-Host "`n=== ALL DONE ==="
Write-Host "Projects: $($projectIds.Count) | Jobs: $($allJobIds.Count) | Applications: $appCount | Communications: $commCount"
