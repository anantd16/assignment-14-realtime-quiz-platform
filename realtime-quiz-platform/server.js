require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const registerLobbyHandlers = require('./sockets/lobbyHandler');
const { registerGameHandlers } = require('./sockets/gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Real-Time Quiz Platform server is running' });
});

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Shared per-connection state (pin + role) so lobby and game handlers
  // both know which room this socket belongs to and whether it's the host.
  const socketState = { pin: null, role: null };

  registerLobbyHandlers(io, socket, socketState);
  registerGameHandlers(io, socket, socketState);

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io };
