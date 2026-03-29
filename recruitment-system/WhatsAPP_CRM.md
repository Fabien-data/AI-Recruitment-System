This is a fantastic feature to build. You already have a very solid foundation here: the frontend dashboard has the 3-panel layout, the WebSocket connection for real-time updates is set up, the database schema supports message_type and attachments, and the takeover/release logic is in place.

Building a seamless human-in-the-loop system where an agent can step in and handle rich media is a classic AI engineering challenge. To turn this into a fully-fledged "WhatsApp inside the CRM," you need to bridge the gap between your frontend input and the WhatsApp Graph API to support files and voice.

Here is the step-by-step implementation plan to add rich media (files, images, voice) to your Message Center.

1. Update the WhatsApp Service (whatsapp.js)
Currently, your whatsapp.js only has sendTextMessage and sendTemplateMessage. You need to add a function to send media. The WhatsApp Graph API allows sending media by providing a publicly accessible URL or a media ID.

Add this function to backend/src/services/whatsapp.js:

JavaScript
/**
 * Send WhatsApp media message (image, document, audio)
 * @param {string} to - Phone number
 * @param {string} type - 'image', 'document', or 'audio'
 * @param {string} mediaUrl - Publicly accessible URL of the media
 * @param {string} [caption] - Optional text caption (for images/documents)
 */
async function sendMediaMessage(to, type, mediaUrl, caption = '') {
    try {
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to.replace(/[^0-9]/g, ''),
            type: type,
            [type]: {
                link: mediaUrl
            }
        };

        if (caption && (type === 'image' || type === 'document')) {
            payload[type].caption = caption;
        }

        const response = await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error(`WhatsApp ${type} send error:`, error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendTextMessage,
    sendTemplateMessage,
    downloadMedia,
    markMessageAsRead,
    sendMediaMessage // Export the new function
};
2. Update the API Route (communications.js)
Your current /send route only expects JSON { candidate_id, channel, message } and defaults to sendTextMessage. You need to modify this endpoint to accept multipart/form-data for file uploads, upload the file to your storage (like Google Cloud Storage or AWS S3), and then call the new sendMediaMessage.

Note: You will need to add a middleware like multer to handle the file parsing.

JavaScript
// Add multer at the top of your file
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // Or configure to use memory storage/Cloud Storage directly
const { sendTextMessage, sendMediaMessage } = require('../services/whatsapp');

// Change the route to handle files
router.post('/send', authenticate, upload.single('media'), async (req, res, next) => {
    try {
        const { candidate_id, channel = 'whatsapp', message, msgType = 'text' } = req.body;
        const file = req.file;

        if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });

        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'), [candidate_id]
        );
        if (candidateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });
        
        const candidate = candidateResult.rows[0];
        let mediaUrl = null;
        let finalContentType = msgType;

        // 1. Handle File Upload if present
        if (file) {
            // TODO: Upload 'file.path' to your Cloud Storage (S3, GCS, etc.)
            // mediaUrl = await uploadToCloudStorage(file);
            
            // For example purposes, assuming you get a public URL:
            mediaUrl = 'https://your-public-bucket.com/' + file.filename; 
            
            if (file.mimetype.startsWith('image/')) finalContentType = 'image';
            else if (file.mimetype.startsWith('audio/')) finalContentType = 'audio';
            else finalContentType = 'document';
        }

        // 2. Send to WhatsApp
        let sendResult = { simulated: false };
        if (channel === 'whatsapp') {
            try {
                if (file && mediaUrl) {
                    await sendMediaMessage(candidate.phone || candidate.whatsapp_phone, finalContentType, mediaUrl, message);
                } else if (message) {
                    await sendTextMessage(candidate.phone || candidate.whatsapp_phone, message);
                }
            } catch (err) {
                logger.warn(`WhatsApp send failed: ${err.message}`);
                sendResult.simulated = true;
            }
        }
        // ... (keep existing SMS/Email logic)

        // 3. Save to Database
        const commId = generateUUID();
        const agentName = req.user?.name || req.user?.email || 'Agent';
        const attachments = mediaUrl ? JSON.stringify([{ url: mediaUrl, type: finalContentType }]) : '[]';

        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content, attachments, sent_by, sender_type, sender_name)
                VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, 'agent', $8)`),
            [commId, candidate_id, channel, finalContentType, message || '', attachments, req.user.id, agentName]
        );

        // 4. Broadcast via WebSocket
        // ... (Update your existing socket.emit to include message_type and attachments)

        return res.status(201).json({ id: commId, direction: 'outbound', content: message, message_type: finalContentType });
    } catch (error) {
        next(error);
    }
});
3. Upgrade Frontend UI (Communications.jsx)
You need to add attachment buttons (like a paperclip for files/images and a microphone for voice) next to your chat input.

Update handleSend to use FormData:
Change your API call from JSON to FormData so it can handle binary files.

JavaScript
const handleSend = useCallback(async (e, file = null) => {
  e?.preventDefault()
  if (!message.trim() && !file) return
  setSendError(null)

  const formData = new FormData()
  formData.append('candidate_id', selectedId)
  formData.append('channel', 'whatsapp')
  if (message) formData.append('message', message)
  if (file) formData.append('media', file)

  try {
    // Note: update apiFetch to NOT set 'Content-Type: application/json' when passing FormData
    const result = await fetch(`${API_BASE}/api/communications/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${useAuthStore.getState().token}` },
        body: formData
    }).then(res => res.json())

    setMessage('')
    // Optimistically append to transcript...
  } catch (err) {
    setSendError('Failed to send.')
  }
}, [message, selectedId])
Add Upload Buttons to the Input Area:

JavaScript
{/* Wrap your textarea with file inputs */}
<div className="flex items-end gap-2 px-4 py-3 bg-white border-t border-slate-200">
    <input 
        type="file" 
        id="file-upload" 
        className="hidden" 
        onChange={(e) => handleSend(null, e.target.files[0])} 
    />
    <label htmlFor="file-upload" className="p-2 text-slate-400 hover:text-indigo-600 cursor-pointer">
        <Paperclip size={20} />
    </label>

    {/* Existing Textarea */}
    <textarea ... />

    <Button type="submit" ...> <Send size={16} /> </Button>
</div>
Update MsgBubble to render rich media:
In your MsgBubble component, check the msg.message_type or msg.attachments. If it's an image, render an <img> tag; if it's audio, render an <audio controls src="..."> tag.

Ensuring All Customers Exist Here
Your current SQL query in /active-chats uses an INNER JOIN on communications, which means it only shows candidates who have at least one message logged. If a candidate is added to the CRM manually but no WhatsApp message has been sent or received yet, they won't appear in this specific chat list.

If you want every candidate to be reachable here regardless of history, change the INNER JOIN to a LEFT JOIN in your /active-chats SQL query, using COALESCE for the sorting timestamp to fall back to the candidate's created_at date.

Here is the complete implementation for adding in-browser voice recording to the agent dashboard. This uses the native Web `MediaRecorder` API to capture microphone audio, allows the agent to preview it, and then sends it as a `multipart/form-data` payload to the updated backend endpoint.

### 1. Update Imports and State in `Communications.jsx`

First, import the new icons you'll need for the recording interface and add the necessary state variables and refs at the top of your component.

```javascript
// Add these to your lucide-react imports
import { Mic, Square, Trash2, Paperclip } from 'lucide-react'

export default function Communications() {
  // ... existing state ...
  
  // Add new state for voice recording
  const [isRecording, setIsRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState(null)
  
  // Refs for managing the MediaRecorder
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
```

### 2. Add the Recording Functions

Add these functions inside your component to handle the microphone permissions, start/stop logic, and cleanup.

```javascript
  // ── Voice Recording Logic ──────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        const url = URL.createObjectURL(blob)
        setAudioBlob(blob)
        setAudioUrl(url)
        
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop())
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (err) {
      console.error("Microphone access denied or error:", err)
      setSendError("Could not access microphone. Please check permissions.")
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  const discardAudio = () => {
    setAudioBlob(null)
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      setAudioUrl(null)
    }
  }
```

### 3. Update the `handleSend` Function

Update your send logic to utilize `FormData` so it can handle both regular text messages, file uploads, and recorded audio blobs.

```javascript
  // ── Send message (Updated for Media) ───────────────────────────────────────
  const handleSend = useCallback(async (e, fileToUpload = null) => {
    e?.preventDefault()
    
    // Determine if we have anything to send
    const hasText = message.trim().length > 0
    const hasAudio = audioBlob !== null
    const hasFile = fileToUpload !== null
    
    if (!hasText && !hasAudio && !hasFile) return
    if (!selectedId) return
    
    setSendError(null)

    const formData = new FormData()
    formData.append('candidate_id', selectedId)
    formData.append('channel', 'whatsapp')

    if (hasText) formData.append('message', message)
    
    if (hasAudio) {
      // Append the recorded audio blob as a file
      formData.append('media', audioBlob, 'voice_note.webm')
      formData.append('msgType', 'audio')
    } else if (hasFile) {
      formData.append('media', fileToUpload)
    }

    try {
      // Note: Do not set Content-Type header when using FormData; 
      // the browser sets it automatically with the correct boundary.
      const token = useAuthStore.getState().token
      const res = await fetch(`${API_BASE}/api/communications/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      })
      
      if (!res.ok) throw new Error('Failed to send')
      const result = await res.json()

      // Reset inputs
      setMessage('')
      discardAudio()
      
      // Optimistically add to transcript
      setTranscript(prev => [...prev, {
        id: result.id || Date.now(),
        direction: 'outbound',
        content: hasAudio ? '🎤 Voice Message' : (hasFile ? '📎 Attachment' : message),
        message_type: result.message_type || 'text',
        sender_type: 'agent',
        sender_name: 'You',
        sent_at: new Date().toISOString(),
      }])
    } catch (err) {
      setSendError('Failed to send. Please try again.')
    }
  }, [message, selectedId, audioBlob])
```

### 4. Replace the Input UI

Replace the `form` section inside your `selectedCandidate?.is_human_handoff` block with this updated UI. It handles three states: Default (Text/File), Recording in Progress, and Audio Preview.

```jsx
          {/* Input Area */}
          {selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-white border-t border-slate-200 shrink-0">
              {sendError && (
                <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
                  <AlertCircle size={12} /> {sendError}
                </div>
              )}
              
              <form onSubmit={handleSend} className="flex items-end gap-2">
                
                {/* STATE 1: Currently Recording */}
                {isRecording ? (
                  <div className="flex-1 flex items-center justify-between bg-red-50 border border-red-200 rounded-xl px-4 py-2 h-11">
                    <div className="flex items-center gap-2 text-red-600 text-sm font-medium animate-pulse">
                      <div className="w-2 h-2 rounded-full bg-red-600" />
                      Recording Voice Note...
                    </div>
                    <button 
                      type="button" 
                      onClick={stopRecording}
                      className="text-red-600 hover:bg-red-100 p-1.5 rounded-lg transition-colors"
                    >
                      <Square size={16} fill="currentColor" />
                    </button>
                  </div>
                ) : 
                
                /* STATE 2: Audio Recorded & Ready to Send */
                audioUrl ? (
                  <div className="flex-1 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 h-11">
                    <button 
                      type="button" 
                      onClick={discardAudio}
                      className="text-slate-400 hover:text-red-500 transition-colors"
                      title="Discard Voice Note"
                    >
                      <Trash2 size={18} />
                    </button>
                    <audio src={audioUrl} controls className="h-7 w-full max-w-[200px]" />
                  </div>
                ) : 
                
                /* STATE 3: Default Text & File Input */
                (
                  <>
                    <div className="flex items-center pb-1">
                      <input 
                        type="file" 
                        id="file-upload" 
                        className="hidden" 
                        onChange={(e) => {
                          if (e.target.files?.[0]) handleSend(null, e.target.files[0])
                        }} 
                      />
                      <label 
                        htmlFor="file-upload" 
                        className="p-2 text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                      >
                        <Paperclip size={20} />
                      </label>
                    </div>

                    <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:bg-white transition-all flex">
                      <textarea
                        value={message}
                        onChange={(e) => {
                          setMessage(e.target.value)
                          socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: true })
                        }}
                        onBlur={() => socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: false })}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                        placeholder="Type a message..."
                        className="w-full bg-transparent border-0 focus:ring-0 p-3 max-h-28 resize-none text-sm"
                        rows={1}
                      />
                    </div>
                  </>
                )}

                {/* Right Side Buttons: Send OR Record */}
                {(message.trim() || audioBlob) ? (
                  <Button
                    type="submit"
                    className="mb-0.5 w-11 h-11 px-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 flex items-center justify-center shrink-0 shadow-sm"
                  >
                    <Send size={18} />
                  </Button>
                ) : !isRecording && (
                  <Button
                    type="button"
                    onClick={startRecording}
                    variant="outline"
                    className="mb-0.5 w-11 h-11 px-0 rounded-xl border-slate-200 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 flex items-center justify-center shrink-0"
                  >
                    <Mic size={20} />
                  </Button>
                )}
              </form>
            </div>
          )}
```