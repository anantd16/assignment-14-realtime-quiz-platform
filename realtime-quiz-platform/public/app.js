// Shared helpers used by both initHostPage() and initPlayerPage()

function $(id) {
  return document.getElementById(id);
}

function showScreen(id, allScreenIds) {
  allScreenIds.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

function showError(message) {
  const box = $('errorBox');
  if (!box) return;
  box.textContent = message;
  box.classList.add('visible');
  setTimeout(() => box.classList.remove('visible'), 3500);
}

function renderLeaderboard(listEl, leaderboard) {
  listEl.innerHTML = '';
  leaderboard.forEach((entry) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="rank-badge">#${entry.rank}</span>
      <span class="lb-name">${escapeHtml(entry.name)}</span>
      <span class="lb-score">${entry.score} pts</span>
    `;
    listEl.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function startCountdown(ringEl, seconds, onTick, onDone) {
  let remaining = seconds;
  ringEl.textContent = remaining;
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      ringEl.textContent = 0;
      if (onDone) onDone();
      return;
    }
    ringEl.textContent = remaining;
    if (onTick) onTick(remaining);
  }, 1000);
  return interval;
}

// =====================================================================
// HOST PAGE
// =====================================================================
function initHostPage() {
  const socket = io();
  const screens = ['setupScreen', 'lobbyScreen', 'gameScreen', 'revealScreen', 'endScreen'];
  let pin = null;

  $('createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const hostName = $('hostName').value.trim();
    const category = $('category').value;
    if (!hostName) return;
    socket.emit('quiz:create', { hostName, category });
  });

  socket.on('quiz:created', (data) => {
    pin = data.pin;
    $('pinDisplay').textContent = pin;
    showScreen('lobbyScreen', screens);
  });

  socket.on('lobby:update', ({ players }) => {
    $('lobbyCount').textContent = `${players.length} player${players.length === 1 ? '' : 's'} joined`;
    $('playerList').innerHTML = players
      .map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score} pts</span></li>`)
      .join('');
    $('startBtn').disabled = players.length === 0;
  });

  $('startBtn').addEventListener('click', () => {
    socket.emit('quiz:start', { pin });
  });

  let timerInterval = null;

  socket.on('question:start', (data) => {
    showScreen('gameScreen', screens);
    $('questionProgress').textContent = `Question ${data.questionIndex} of ${data.totalQuestions}`;
    $('questionText').textContent = data.question;

    const grid = $('optionsGrid');
    grid.innerHTML = '';
    data.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = opt;
      btn.disabled = true; // host doesn't answer
      grid.appendChild(btn);
    });

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = startCountdown($('timerRing'), data.timeLimitSeconds);
  });

  socket.on('question:time_up', ({ correctOption, explanation }) => {
    if (timerInterval) clearInterval(timerInterval);
    $('explanationText').textContent = explanation;

    const buttons = $('optionsGrid').querySelectorAll('.option-btn');
    buttons.forEach((btn, i) => {
      btn.classList.toggle('correct', i === correctOption);
      btn.classList.toggle('incorrect', i !== correctOption);
    });
  });

  socket.on('leaderboard:update', ({ leaderboard }) => {
    showScreen('revealScreen', screens);
    renderLeaderboard($('leaderboardList'), leaderboard);
  });

  socket.on('quiz:ended', ({ winner, finalRanks }) => {
    showScreen('endScreen', screens);
    $('winnerBanner').textContent = winner ? `🎉 ${winner.name} wins with ${winner.score} points!` : 'No players finished.';
    renderLeaderboard($('finalLeaderboardList'), finalRanks);
  });

  socket.on('quiz:error', ({ message }) => showError(message));
}

// =====================================================================
// PLAYER PAGE
// =====================================================================
function initPlayerPage() {
  const socket = io();
  const screens = ['joinScreen', 'waitingScreen', 'gameScreen', 'revealScreen', 'endScreen'];
  let pin = null;
  let questionStartedAtClient = null;
  let hasAnsweredThisRound = false;

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inputPin = $('pinInput').value.trim();
    const playerName = $('playerNameInput').value.trim();
    if (!inputPin || !playerName) return;
    socket.emit('quiz:join', { pin: inputPin, playerName });
  });

  socket.on('quiz:joined', (data) => {
    pin = data.pin;
    showScreen('waitingScreen', screens);
  });

  socket.on('lobby:update', () => {
    // Player just sees the waiting screen; roster details aren't critical here.
  });

  let timerInterval = null;

  socket.on('question:start', (data) => {
    showScreen('gameScreen', screens);
    hasAnsweredThisRound = false;
    questionStartedAtClient = Date.now();

    $('questionProgress').textContent = `Question ${data.questionIndex} of ${data.totalQuestions}`;
    $('questionText').textContent = data.question;
    $('answerStatus').textContent = '';

    const grid = $('optionsGrid');
    grid.innerHTML = '';
    data.options.forEach((opt, index) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => submitAnswer(index));
      grid.appendChild(btn);
    });

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = startCountdown($('timerRing'), data.timeLimitSeconds, null, () => {
      // Time ran out locally — disable buttons so the player can't try to
      // sneak an answer in after their own clock hits zero. The server
      // enforces this independently regardless.
      disableOptions();
    });
  });

  function submitAnswer(selectedOption) {
    if (hasAnsweredThisRound) return;
    hasAnsweredThisRound = true;
    disableOptions();

    const timeTakenMs = Date.now() - questionStartedAtClient;
    socket.emit('answer:submit', { pin, selectedOption, timeTakenMs });

    const buttons = $('optionsGrid').querySelectorAll('.option-btn');
    buttons[selectedOption]?.classList.add('correct');
    $('answerStatus').textContent = 'Answer locked in!';
  }

  function disableOptions() {
    $('optionsGrid').querySelectorAll('.option-btn').forEach((btn) => (btn.disabled = true));
  }

  socket.on('answer:result', ({ correct, pointsEarned, totalScore }) => {
    const toast = $('scoreToast');
    toast.textContent = correct ? `✅ Correct! +${pointsEarned} pts (total: ${totalScore})` : '❌ Incorrect';
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2500);
  });

  socket.on('question:time_up', ({ correctOption, explanation }) => {
    if (timerInterval) clearInterval(timerInterval);
    disableOptions();

    $('revealHeadline').textContent = hasAnsweredThisRound ? "Time's up!" : "You didn't answer in time!";
    $('explanationText').textContent = explanation;

    const buttons = $('optionsGrid').querySelectorAll('.option-btn');
    buttons.forEach((btn, i) => {
      btn.classList.toggle('correct', i === correctOption);
    });
  });

  socket.on('leaderboard:update', ({ leaderboard }) => {
    showScreen('revealScreen', screens);
    renderLeaderboard($('leaderboardList'), leaderboard);
  });

  socket.on('quiz:ended', ({ winner, finalRanks }) => {
    showScreen('endScreen', screens);
    $('winnerBanner').textContent = winner ? `🎉 ${winner.name} wins with ${winner.score} points!` : 'No players finished.';
    renderLeaderboard($('finalLeaderboardList'), finalRanks);
  });

  socket.on('quiz:error', ({ message }) => showError(message));
}
