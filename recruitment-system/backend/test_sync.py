import requests
import json
import base64

api_url = "http://localhost:3000/api/chatbot/intake"
api_key = "dewan_chatbot_secret_2024_change_in_production"

# Create a dummy PDF
dummy_pdf = b"%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n"
b64_pdf = base64.b64encode(dummy_pdf).decode('utf-8')

payload = {
    "phone": "+94770002222",
    "name": "Test Candidate B64",
    "job_interest": "Software Engineer",
    "cv_file_name": "test_cv.pdf",
    "cv_base64": b64_pdf
}

headers = {"x-chatbot-api-key": api_key, "Content-Type": "application/json"}
try:
    res = requests.post(api_url, json=payload, headers=headers)
    print(res.status_code, res.text)
except Exception as e:
    print(f"Error: {e}")
