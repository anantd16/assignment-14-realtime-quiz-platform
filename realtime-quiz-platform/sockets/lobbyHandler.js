const { rooms, createRoom, getRoom } = require('./gameEngine');

/**
 * Generates a unique 4-digit PIN not already in use by an active room.
 */
function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[pin]);
  return pin;
}

/**
 * Registers lobby-related event listeners: room creation by the host and
 * players joining via PIN. Game-round logic lives in gameEngine.js.
 */
function registerLobbyHandlers(io, socket, socketState) {
  /**
   * quiz:create — Host -> Server
   * { hostName, category }
   */
  socket.on('quiz:create', ({ hostName, category }) => {
    if (!hostName || !category) {
      socket.emit('quiz:error', { message: 'hostName and category are required' });
      return;
    }

    const pin = generatePin();
    const room = createRoom({ pin, hostSocketId: socket.id, hostName, category });

    socket.join(pin);
    socketState.pin = pin;
    socketState.role = 'host';

    socket.emit('quiz:created', { pin, roomId: room.roomId });
  });

  /**
   * quiz:join — Player -> Server
   * { pin, playerName }
   */
  socket.on('quiz:join', ({ pin, playerName }) => {
    if (!pin || !playerName) {
      socket.emit('quiz:error', { message: 'pin and playerName are required' });
      return;
    }

    const room = getRoom(pin);
    if (!room) {
      socket.emit('quiz:error', { message: 'No quiz room found with that PIN' });
      return;
    }
    if (room.status !== 'lobby') {
      socket.emit('quiz:error', { message: 'This quiz has already started or ended' });
      return;
    }
    if (Object.values(room.players).some((p) => p.name.toLowerCase() === playerName.toLowerCase())) {
      socket.emit('quiz:error', { message: 'That name is already taken in this lobby' });
      return;
    }

    room.players[socket.id] = { name: playerName, score: 0 };

    socket.join(pin);
    socketState.pin = pin;
    socketState.role = 'player';

    socket.emit('quiz:joined', { pin, playerName, category: room.category, hostName: room.hostName });

    io.to(pin).emit('lobby:update', {
      players: Object.values(room.players).map((p) => ({ name: p.name, score: p.score }))
    });
  });

  /**
   * Cleanup on disconnect: remove player from their room's roster (if a
   * player), or mark the room orphaned (if the host left mid-lobby).
   */
  socket.on('disconnect', () => {
    const { pin, role } = socketState;
    if (!pin) return;
    const room = getRoom(pin);
    if (!room) return;

    if (role === 'player' && room.players[socket.id]) {
      delete room.players[socket.id];
      io.to(pin).emit('lobby:update', {
        players: Object.values(room.players).map((p) => ({ name: p.name, score: p.score }))
      });
    }

    if (role === 'host') {
      room.hostConnected = false;
      socket.to(pin).emit('quiz:error', { message: 'The host has disconnected' });
    }
  });
}

module.exports = registerLobbyHandlers;
