# 🧠 Real-Time Multiplayer Live Quiz Battle

A Kahoot-style multiplayer trivia platform — PIN-based rooms, server-authoritative countdown timers, speed-based scoring, and live leaderboards — built with **Node.js, Express, and Socket.io**.

## Tech Stack

- Node.js + Express (serves the static frontend)
- Socket.io (WebSocket transport for all real-time game events)
- In-memory game state engine — no database
- Plain HTML/CSS/JS frontend (no build step)

## Setup

```bash
npm install
cp .env.example .env   # optionally change PORT
npm run dev             # nodemon, auto-restart
# or
npm start
```

## How to Play (matches the assignment's testing guide)

1. Start the server — it runs on `http://localhost:5000` by default.
2. Open **Tab 1**: `http://localhost:5000/host.html`. Enter a host name, pick a category, click **Create Quiz** — note the 4-digit PIN.
3. Open **Tab 2** and **Tab 3**: `http://localhost:5000/player.html`. Enter the PIN and join as "Player 1" and "Player 2".
4. From the host tab, click **Start Game** once at least one player has joined.
5. Answer quickly on Player 1; wait several seconds before answering on Player 2.
6. Player 1 will score higher on that question due to the speed bonus, even though both answered correctly.
7. After the 15-second timer expires, neither player can submit an answer for that question anymore — the server rejects it regardless of the client's own clock.

## Real-Time Event Protocol

**Lobby & game control**

| Event | Direction | Payload |
|---|---|---|
| `quiz:create` | Host → Server | `{ hostName, category }` |
| `quiz:created` | Server → Host | `{ pin, roomId }` |
| `quiz:join` | Player → Server | `{ pin, playerName }` |
| `quiz:joined` | Server → Player | `{ pin, playerName, category, hostName }` |
| `lobby:update` | Server → Room | `{ players: [{ name, score }] }` |
| `quiz:start` | Host → Server | `{ pin }` |
| `quiz:error` | Server → Socket | `{ message }` |

**Question rounds & live gameplay**

| Event | Direction | Payload |
|---|---|---|
| `question:start` | Server → Room | `{ questionIndex, totalQuestions, question, options, timeLimitSeconds }` — correct answer omitted |
| `answer:submit` | Player → Server | `{ pin, selectedOption, timeTakenMs }` |
| `answer:result` | Server → Player | `{ correct, pointsEarned, totalScore }` — sent only to the answering player |
| `question:time_up` | Server → Room | `{ correctOption, explanation }` |
| `leaderboard:update` | Server → Room | `{ leaderboard: [{ rank, name, score }] }` |
| `quiz:ended` | Server → Room | `{ winner, finalRanks }` |

## Key Design Notes

- **Server-authoritative timer**: each question round is driven by a single `setTimeout` on the server (`sockets/gameEngine.js`), not by any client's countdown. The 15-second display timer on host/player screens is purely cosmetic — the server independently measures `Date.now() - room.questionStartedAt` and will reject any `answer:submit` that arrives after its own timer already fired, even if a client's local clock is out of sync or has been tampered with.
- **Anti-cheat validation**: an answer is rejected with a `quiz:error` if (a) the round has already ended server-side, (b) the player already answered this round, or (c) the sender isn't a recognized player in that room. The client-reported `timeTakenMs` is also clamped against the server's own elapsed-time measurement before being used in scoring, so a modified client can't claim an impossibly fast response.
- **Scoring formula** (`calculateScore` in `gameEngine.js`), matching the assignment exactly:
  ```
  score = 0                                    // if incorrect
  score = 500 + round((timeRemaining / 15000) * 500)   // if correct, up to 1000 max
  ```
- **Correct answer is never sent early**: `question:start` broadcasts only the question text and options — `correctOption` and `explanation` are withheld until `question:time_up` fires after the round ends, so no client can peek at the answer mid-round.
- **Leaderboard** is recalculated and re-sorted after every round from the room's live `players` map, so rank changes are always reflected accurately.

## Testing Note

This was verified with an automated multi-client Socket.io integration test during development (host + 3 simulated players in one room, run against a full 5-question quiz), covering: PIN generation, lobby roster sync, correct-answer withholding in `question:start`, speed-based score differentiation between a fast and slow correct answer, leaderboard sort order, and anti-cheat rejection of a late answer submission. All checks passed. One real bug was caught and fixed in this process: a late `answer:submit` arriving after the round's `currentQuestion` had already been cleared was previously dropped silently instead of returning a `quiz:error`, which would have left the player's UI stuck with no feedback — this is now always explicitly rejected.

## Project Structure

```
realtime-quiz-platform/
├── public/
│   ├── index.html        # Host / Player entry portal
│   ├── host.html          # Host control dashboard
│   ├── player.html        # Mobile-friendly player answer grid
│   ├── app.js              # Shared client-side socket handlers
│   └── styles.css
├── data/
│   └── questions.json     # Sample question bank (Tech, General)
├── sockets/
│   ├── gameEngine.js       # Room state, timers, scoring, leaderboard, anti-cheat
│   └── lobbyHandler.js     # PIN generation & player joining
├── .env.example
├── .gitignore
├── package.json
├── server.js
└── README.md
```
