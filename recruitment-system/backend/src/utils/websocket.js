/**
 * WebSocket Server (Socket.io)
 * =============================
 * Provides real-time communication between the recruitment system
 * dashboard and the WhatsApp chatbot.
 *
 * Rooms:
 *   - agent:{user_id}       — private room for a specific agent
 *   - candidate:{id}        — all agents watching this candidate's chat
 *   - global                — chat list activity feed (all agents)
 *
 * Events emitted by server:
 *   new_message    — a new chat message arrived (inbound or outbound)
 *   chat_activity  — lightweight ping to update the candidate list
 *   handoff_start  — candidate is now under human control
 *   handoff_end    — candidate handed back to bot
 *   agent_typing   — an agent is composing a reply
 *
 * Events received from agents:
 *   join_candidate   — subscribe to a candidate's chat room
 *   leave_candidate  — unsubscribe
 *   typing           — agent is typing (relayed to room)
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

let _io = null;

/**
 * Initialize the Socket.io server attached to an existing http.Server.
 * Call once from server.js after app.listen().
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function initWebSocket(httpServer) {
    const allowedOrigins = [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:3000',
        process.env.FRONTEND_URL,
        process.env.CORS_ORIGIN,
        'https://recruitment.markui.lk',
    ].filter(Boolean);

    _io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true,
        },
        // Automatically disconnect idle sockets after 2 minutes (saves memory)
        pingTimeout: 120000,
        pingInterval: 25000,
    });

    // ── JWT Authentication middleware ──────────────────────────────────────────
    _io.use((socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.split(' ')[1];

        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const secret = process.env.JWT_SECRET;
            if (!secret) return next(new Error('JWT_SECRET not configured'));
            const decoded = jwt.verify(token, secret);
            socket.user = decoded; // { id, email, role, ... }
            next();
        } catch (err) {
            next(new Error('Invalid or expired token'));
        }
    });

    // ── Connection handler ─────────────────────────────────────────────────────
    _io.on('connection', (socket) => {
        const userId = socket.user?.id;
        const userEmail = socket.user?.email || 'unknown';
        logger.info(`WebSocket connected: user=${userEmail} socket=${socket.id}`);

        // All authenticated users join the global room automatically
        socket.join('global');

        // Join the agent's own private room
        if (userId) {
            socket.join(`agent:${userId}`);
        }

        // ── Join a candidate chat room ─────────────────────────────────────────
        socket.on('join_candidate', (candidateId) => {
            if (!candidateId) return;
            const room = `candidate:${candidateId}`;
            socket.join(room);
            logger.debug(`WebSocket: ${userEmail} joined room ${room}`);
        });

        // ── Leave a candidate chat room ────────────────────────────────────────
        socket.on('leave_candidate', (candidateId) => {
            if (!candidateId) return;
            const room = `candidate:${candidateId}`;
            socket.leave(room);
            logger.debug(`WebSocket: ${userEmail} left room ${room}`);
        });

        // ── Typing indicator (relay to room members) ──────────────────────────
        socket.on('typing', ({ candidateId, isTyping }) => {
            if (!candidateId) return;
            socket.to(`candidate:${candidateId}`).emit('agent_typing', {
                agent_id: userId,
                agent_name: userEmail,
                is_typing: Boolean(isTyping),
            });
        });

        // ── Disconnect ────────────────────────────────────────────────────────
        socket.on('disconnect', (reason) => {
            logger.debug(`WebSocket disconnected: user=${userEmail} reason=${reason}`);
        });
    });

    logger.info('✅ Socket.io WebSocket server initialized');
    return _io;
}

/**
 * Get the singleton Socket.io instance.
 * Returns null if initWebSocket() has not been called yet.
 */
function getIO() {
    return _io;
}

module.exports = { initWebSocket, getIO };
