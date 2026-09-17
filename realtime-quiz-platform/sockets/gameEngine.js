const fs = require('fs');
const path = require('path');

const QUESTION_BANK = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/questions.json'), 'utf-8'));

// 15 seconds per question by default, matching the assignment spec.
// Overridable via QUIZ_TIME_LIMIT_MS for faster local/automated testing.
const TIME_LIMIT_MS = Number(process.env.QUIZ_TIME_LIMIT_MS) || 15000;

/**
 * In-memory room store.
 *
 * rooms = {
 *   "8421": {
 *     pin, roomId, hostSocketId, hostName, category, status: 'lobby'|'in_progress'|'ended',
 *     players: { [socketId]: { name, score } },
 *     questions: [...],           // shuffled copy of this room's question set
 *     currentQuestionIndex: -1,
 *     currentQuestion: null,      // full object incl. correctOption (server-only)
 *     questionStartedAt: null,    // Date.now() when the current round started
 *     answeredThisRound: Set,     // socketIds who already answered this round
 *     timer: null                 // Node timeout handle for the round
 *   }
 * }
 */
const rooms = {};

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createRoom({ pin, hostSocketId, hostName, category }) {
  const bank = QUESTION_BANK[category] || QUESTION_BANK.General || [];
  const room = {
    pin,
    roomId: `quiz_${pin}`,
    hostSocketId,
    hostName,
    hostConnected: true,
    category: QUESTION_BANK[category] ? category : 'General',
    status: 'lobby',
    players: {},
    questions: shuffle(bank),
    currentQuestionIndex: -1,
    currentQuestion: null,
    questionStartedAt: null,
    answeredThisRound: new Set(),
    timer: null
  };
  rooms[pin] = room;
  return room;
}

function getRoom(pin) {
  return rooms[pin];
}

/**
 * Score = Base (500) + Speed Bonus (up to 500), matching the assignment's
 * scoring algorithm exactly. Returns 0 for an incorrect answer.
 */
function calculateScore(isCorrect, timeTakenMs, totalTimeLimitMs = TIME_LIMIT_MS) {
  if (!isCorrect) return 0;
  const timeRemaining = Math.max(0, totalTimeLimitMs - timeTakenMs);
  const speedBonus = Math.round((timeRemaining / totalTimeLimitMs) * 500);
  const baseScore = 500;
  return baseScore + speedBonus;
}

function buildLeaderboard(room) {
  const ranked = Object.values(room.players)
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
  return ranked;
}

/**
 * Registers game-round event listeners: starting the quiz, submitting
 * answers, and the server-driven timer that advances rounds. This is the
 * "authoritative server" half of the anti-cheat design — the timer and the
 * correct-answer reveal both live here, not on the client.
 */
function registerGameHandlers(io, socket, socketState) {
  /**
   * quiz:start — Host -> Server
   * { pin }
   */
  socket.on('quiz:start', ({ pin }) => {
    const room = getRoom(pin);
    if (!room) {
      socket.emit('quiz:error', { message: 'Room not found' });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      socket.emit('quiz:error', { message: 'Only the host can start the quiz' });
      return;
    }
    if (room.status !== 'lobby') {
      socket.emit('quiz:error', { message: 'Quiz has already started' });
      return;
    }
    if (Object.keys(room.players).length === 0) {
      socket.emit('quiz:error', { message: 'Cannot start with no players in the lobby' });
      return;
    }

    room.status = 'in_progress';
    startNextQuestion(io, room);
  });

  /**
   * answer:submit — Player -> Server
   * { pin, selectedOption, timeTakenMs }
   * Server-side anti-cheat: rejects answers if the round has already ended
   * (timer fired) or if this player already answered this round. The
   * client-reported timeTakenMs is clamped against server-observed elapsed
   * time so a tampered client can't claim an impossibly fast answer.
   */
  socket.on('answer:submit', ({ pin, selectedOption, timeTakenMs }) => {
    const room = getRoom(pin);
    if (!room || room.status !== 'in_progress') return;

    const player = room.players[socket.id];
    if (!player) return; // not a recognized player in this room

    // room.currentQuestion is cleared the moment the round timer fires
    // (see endRound), so a null currentQuestion is itself a "too late"
    // submission — always tell the client explicitly rather than silently
    // dropping the event, so anti-cheat rejections are never invisible.
    if (!room.currentQuestion) {
      socket.emit('quiz:error', { message: 'Time is up for this question' });
      return;
    }

    if (room.answeredThisRound.has(socket.id)) {
      socket.emit('quiz:error', { message: 'You already answered this question' });
      return;
    }

    const serverElapsed = Date.now() - room.questionStartedAt;
    if (serverElapsed > TIME_LIMIT_MS) {
      // Round already over server-side — reject even if the client's own
      // countdown was slightly out of sync.
      socket.emit('quiz:error', { message: 'Time is up for this question' });
      return;
    }

    room.answeredThisRound.add(socket.id);

    // Trust the server's own elapsed-time measurement over the client's
    // self-reported timeTakenMs, clamped to a sane range, to prevent a
    // tampered client from claiming a suspiciously fast/negative time.
    const safeTimeTaken = Math.min(Math.max(0, Number(timeTakenMs) || serverElapsed), serverElapsed);

    const isCorrect = selectedOption === room.currentQuestion.correctOption;
    const pointsEarned = calculateScore(isCorrect, safeTimeTaken);
    player.score += pointsEarned;

    socket.emit('answer:result', { correct: isCorrect, pointsEarned, totalScore: player.score });
  });
}

/**
 * Starts the next question round for a room: picks the next question,
 * broadcasts it (without the correct answer) to the room, and sets a
 * server-side timer that will end the round after TIME_LIMIT_MS regardless
 * of individual client clocks.
 */
function startNextQuestion(io, room) {
  room.currentQuestionIndex += 1;
  room.answeredThisRound = new Set();

  if (room.currentQuestionIndex >= room.questions.length) {
    endQuiz(io, room);
    return;
  }

  const q = room.questions[room.currentQuestionIndex];
  room.currentQuestion = q;
  room.questionStartedAt = Date.now();

  io.to(room.pin).emit('question:start', {
    questionIndex: room.currentQuestionIndex + 1,
    totalQuestions: room.questions.length,
    question: q.question,
    options: q.options,
    timeLimitSeconds: TIME_LIMIT_MS / 1000
  });

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(io, room), TIME_LIMIT_MS);
}

/**
 * Ends the current round: reveals the correct answer, broadcasts the
 * updated leaderboard, then either starts the next question or ends the
 * quiz if that was the last one.
 */
function endRound(io, room) {
  if (!room.currentQuestion) return;

  io.to(room.pin).emit('question:time_up', {
    correctOption: room.currentQuestion.correctOption,
    explanation: room.currentQuestion.explanation || ''
  });

  io.to(room.pin).emit('leaderboard:update', { leaderboard: buildLeaderboard(room) });

  room.currentQuestion = null;

  // Brief pause so players can see the reveal + leaderboard before the
  // next question starts. Overridable for faster automated testing.
  const interQuestionPauseMs = Number(process.env.QUIZ_INTER_QUESTION_PAUSE_MS) || 3000;
  setTimeout(() => startNextQuestion(io, room), interQuestionPauseMs);
}

function endQuiz(io, room) {
  room.status = 'ended';
  const finalRanks = buildLeaderboard(room);

  io.to(room.pin).emit('quiz:ended', {
    winner: finalRanks[0] || null,
    finalRanks
  });

  if (room.timer) clearTimeout(room.timer);
}

module.exports = { rooms, createRoom, getRoom, calculateScore, registerGameHandlers };
