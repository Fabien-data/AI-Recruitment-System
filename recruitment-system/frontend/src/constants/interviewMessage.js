// Default interview-details message body.
//
// This block is sent as the FULL body of the interview WhatsApp (the chatbot adds
// a short localized "Hi {name}, your interview for {job} is on {date} at {venue}"
// header, then this block follows). The chatbot translates the prose into the
// candidate's language while keeping the addresses and Google-Maps links verbatim.
//
// Agents can edit it per batch in the schedule modal; their last-used text is
// remembered in localStorage (see DEFAULT_INTERVIEW_MESSAGE_KEY). "Reset" restores
// this default.
export const DEFAULT_INTERVIEW_MESSAGE = `📌 INTERVIEW DETAILS

You are invited to attend the interview. Please read the instructions below carefully.

🏛️ INTERVIEW HALL (Main venue – come here directly)
131 Jayantha Weerasekara Mawatha, Colombo 01000
📍 https://share.google/TupQHROAaM9uIPCm1

🏢 Dewan Consultants Office (Optional meeting point)
2, No 83, 18 Chatham St, Colombo 00100
📍 https://share.google/Tui2IukEQg2Bnga1N

👉 Please come DIRECTLY to the Interview Hall.
If you are unsure of the way or prefer to meet us first, come to our Office and we will bring you to the hall from there.

✅ PLEASE BE PREPARED:
* Original NIC / Passport
* Updated CV
* 2 passport-size photos
* Copies of educational / experience certificates
* Dress smartly and arrive on time

For any questions, contact us. We look forward to meeting you.`

// localStorage key for the agent's last-used interview message (remembered across
// batches so they don't re-type it). Falls back to DEFAULT_INTERVIEW_MESSAGE.
export const DEFAULT_INTERVIEW_MESSAGE_KEY = 'interview.defaultMessage'
