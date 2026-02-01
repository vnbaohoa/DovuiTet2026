// server.js (FINAL + single-device login + host kick + host-approved takeover)
// - Loads teams from Teams sheet
// - Loads questions from Questions sheet (teacher editable)
// - Runs game: lobby -> question (paused/live) -> revealed -> finished
// - Logs QuestionLog (one row per question run)
// - Logs AnswerLog (one row per team per question)
// - Updates Teams.score after each question
// - Enforces one device per team pin
// - Allows host to kick and approve takeover requests

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
require("dotenv").config();

const {
  loadTeamsFromSheet,
  loadQuestionsFromSheet,
  updateScoresToSheet,
  appendQuestionRow,
  appendAnswerRows,
} = require("./sheets_store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const GAME_TITLE = "Đố vui Tết 2026";

function makeGameId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// ------------------- DATA LOADED FROM SHEETS -------------------
let TEAM_REGISTRY = [];   // [{pin,name,avatarUrl}]
let QUESTION_BANK = [];   // [{qId,text,choices[],correctIndex,timeSec,mediaType?,mediaUrl?}]

// ------------------- HELPERS -------------------
function cloneDeep(obj) { return JSON.parse(JSON.stringify(obj)); }
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function shuffleChoicesForQuestion(q) {
  const qCopy = cloneDeep(q);
  const pairs = qCopy.choices.map((c, idx) => ({ c, origIdx: idx }));
  shuffleArray(pairs);
  qCopy.choices = pairs.map(p => p.c);
  qCopy.correctIndex = pairs.findIndex(p => p.origIdx === q.correctIndex);
  return qCopy;
}
function buildGameQuestions({ shuffleQuestions, shuffleChoices }) {
  let qlist = cloneDeep(QUESTION_BANK);
  if (shuffleChoices) qlist = qlist.map(q => shuffleChoicesForQuestion(q));
  if (shuffleQuestions) shuffleArray(qlist);
  return qlist;
}
function safeChoice(q, i) {
  return (q && q.choices && q.choices[i] != null) ? String(q.choices[i]) : "";
}
function getClientIp(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return socket.handshake.address || "";
}
function getUserAgent(socket) {
  return socket.handshake.headers["user-agent"] || "";
}
// 0 if wrong. If correct: 20 points if answered within first 4 seconds,
// then -1 point for each second later (based on whole seconds late).
function computeQuestionScore(isCorrect, lockedAtRunMs, timeSec) {
  if (!isCorrect) return 0;

  timeSec = Number.isFinite(timeSec) ? Math.max(1, Math.round(timeSec)) : 20;
  const elapsedSec = Number.isFinite(lockedAtRunMs) ? (lockedAtRunMs / 1000) : timeSec;

  const maxPoints = 20;

  // first 4 seconds => full points
  if (elapsedSec <= 4) return maxPoints;

  // late seconds beyond the first 4 seconds
  const secondsLate = Math.max(0, Math.ceil(elapsedSec - 4));
  return Math.max(0, maxPoints - secondsLate);
}

// ------------------- STATE -------------------
let state = resetState();

/**
 * pendingTakeovers: Map<pin, { requesterId, requestedAt, ip, userAgent }>
 * requesterId is the socket.id of the device asking to take over that PIN.
 */
let pendingTakeovers = new Map();

function resetState() {
  return {
    title: GAME_TITLE,
    gameId: makeGameId(),

    phase: "lobby",         // lobby | question | revealed | leaderboard | finished
    qIndex: -1,
    paused: true,
    manualScoring: false,

    // timing
    startedAtMs: 0,
    accumulatedRunMs: 0,
    timeSec: 20,

    // shuffle toggles
    shuffleQuestions: true,
    shuffleChoices: true,

    // built when host starts
    gameQuestions: null,

    // teams
    teams: new Map(),        // socketId -> team object
    claimedPins: new Set(),  // pins currently logged in

    // roles
    hostId: null,
    projectorIds: new Set(),

    // question logging
    questionLogged: false,
    questionRunId: ""
  };
}

function getCurrentQuestionObj() {
  if (state.gameQuestions && state.qIndex >= 0) return state.gameQuestions[state.qIndex];
  return null;
}

function getRunElapsedMs() {
  if (state.phase !== "question") return state.accumulatedRunMs;
  if (state.paused) return state.accumulatedRunMs;
  return state.accumulatedRunMs + (Date.now() - state.startedAtMs);
}

function getRemainingSec() {
  if (state.phase !== "question") return null;
  const elapsed = getRunElapsedMs() / 1000;
  return Math.max(0, Math.ceil(state.timeSec - elapsed));
}

// Public state sent to everyone (projector/teams)
function publicState() {
  const teams = [...state.teams.values()].map(t => ({
    id: t.id,
    pin: t.pin,
    name: t.name,
    avatarUrl: t.avatarUrl,
    // NEW: members list from Teams sheet; leader is the first name
    members: Array.isArray(t.members) ? t.members : [],
    leaderName: t.leaderName || "",

    score: t.score,
    lockedChoice: t.lockedChoice,
    lockedAtRunMs: t.lockedAtRunMs,
    lastResult: t.lastResult
  }));

  return {
    title: state.title,
    phase: state.phase,
    qIndex: state.qIndex,
    paused: state.paused,
    manualScoring: state.manualScoring,
    timer: getRemainingSec(),
    question: getCurrentQuestionObj(),
    teams,
    shuffleQuestions: !!state.shuffleQuestions,
    shuffleChoices: !!state.shuffleChoices
  };
}

// Host-only state includes device info + takeover queue
function hostState() {
  const teams = [...state.teams.values()].map(t => ({
    id: t.id,
    pin: t.pin,
    name: t.name,
    avatarUrl: t.avatarUrl,
    score: t.score,

    // NEW: display leader/member list for monitoring
    members: Array.isArray(t.members) ? t.members : [],
    leaderName: t.leaderName || "",

    joinedAt: t.joinedAt,
    ip: t.ip,
    userAgent: t.userAgent
  }));

  const takeovers = [...pendingTakeovers.entries()].map(([pin, req]) => ({
    pin,
    requesterId: req.requesterId,
    requestedAt: req.requestedAt,
    ip: req.ip,
    userAgent: req.userAgent
  }));

  return {
    teams,
    takeovers
  };
}

function isHost(socket) { return socket.id === state.hostId; }

function broadcast() {
  io.emit("state", publicState());
  if (state.hostId) {
    io.to(state.hostId).emit("hostState", hostState());
  }
}

function makeQuestionRunId() {
  return `${state.gameId}-Q${state.qIndex + 1}-${Date.now()}`;
}

// ------------------- SHEET WRITES -------------------
async function logQuestionIfNeeded() {
  if (state.phase !== "question") return;
  if (state.questionLogged) return;

  const q = getCurrentQuestionObj();
  if (!q) return;

  state.questionLogged = true;
  state.questionRunId = makeQuestionRunId();

  const ts = new Date().toISOString();
  const correctLetter = "ABCD"[q.correctIndex] || "";

  const row = [
    ts,
    state.gameId,
    state.questionRunId,
    state.qIndex + 1,
    q.text || "",
    q.mediaType || "",
    q.mediaUrl || "",
    safeChoice(q, 0),
    safeChoice(q, 1),
    safeChoice(q, 2),
    safeChoice(q, 3),
    correctLetter
  ];

  try {
    await appendQuestionRow(row);
    console.log(`🧾 QuestionLog: logged Q${state.qIndex + 1} (questionRunId=${state.questionRunId}).`);
  } catch (err) {
    console.error("❌ QuestionLog write failed:", err.message || err);
  }
}

async function logAnswersNow() {
  const q = getCurrentQuestionObj();
  if (!q) return;

  const ts = new Date().toISOString();
  const rows = [];

  for (const t of state.teams.values()) {
    const answerLetter = (t.lockedChoice == null) ? "" : "ABCD"[t.lockedChoice];
    const isCorrect = (t.lockedChoice === q.correctIndex) ? "TRUE" : "FALSE";
    const timeMs = (t.lockedAtRunMs == null) ? "" : Math.round(t.lockedAtRunMs);
    const points = t.lastPointsAwarded || 0;

    rows.push([
      ts,
      state.gameId,
      state.questionRunId || "",
      state.qIndex + 1,
      t.pin,
      t.name,
      answerLetter,
      isCorrect,
      timeMs,
      points,
      t.score
    ]);
  }

  try {
    const res = await appendAnswerRows(rows);
    console.log(`🧾 AnswerLog: logged answers for Q${state.qIndex + 1} (${res.appended} rows).`);
  } catch (err) {
    console.error("❌ AnswerLog write failed:", err.message || err);
  }
}

async function syncTotalsToTeamsSheet() {
  const pinToScore = {};
  for (const t of state.teams.values()) pinToScore[t.pin] = t.score;

  try {
    const res = await updateScoresToSheet(pinToScore);
    console.log(`📊 Teams totals synced (${res.updated} rows).`);
  } catch (err) {
    console.error("❌ Teams sync failed:", err.message || err);
  }
}

// ------------------- GAME FLOW -------------------
function startQuestion(index) {
  state.phase = "question";
  state.qIndex = index;
  state.paused = true;
  state.accumulatedRunMs = 0;
  state.startedAtMs = 0;

  state.questionLogged = false;
  state.questionRunId = "";

  const q = getCurrentQuestionObj();
  state.timeSec = (q && typeof q.timeSec === "number") ? q.timeSec : 20;

  for (const team of state.teams.values()) {
    team.lockedChoice = null;
    team.lockedAtRunMs = null;
    team.lastResult = null;
    team.lastPointsAwarded = 0;
  }
}

function resume() {
  if (state.phase !== "question" || !state.paused) return;
  logQuestionIfNeeded().finally(() => {});
  state.paused = false;
  state.startedAtMs = Date.now();
}

function pause() {
  if (state.phase !== "question" || state.paused) return;
  state.accumulatedRunMs += (Date.now() - state.startedAtMs);
  state.startedAtMs = 0;
  state.paused = true;
}

function revealAnswer() {
  if (state.phase !== "question") return;

  if (!state.paused && state.startedAtMs) {
    state.accumulatedRunMs += (Date.now() - state.startedAtMs);
    state.startedAtMs = 0;
  }
  state.paused = true;
  state.phase = "revealed";

  const q = getCurrentQuestionObj();
  if (!q) return;

  logQuestionIfNeeded().finally(() => {});

  if (state.manualScoring) {
    for (const t of state.teams.values()) {
      t.lastResult = null;
      t.lastPointsAwarded = 0;
    }
    logAnswersNow().finally(() => {});
    syncTotalsToTeamsSheet().finally(() => {});
    return;
  }

    const correct = q.correctIndex;

  for (const t of state.teams.values()) {
    t.lastPointsAwarded = 0;

    // no answer => wrong => 0
    if (t.lockedChoice == null || t.lockedAtRunMs == null) {
      t.lastResult = "wrong";
      continue;
    }

    const isCorrect = (t.lockedChoice === correct);
    t.lastResult = isCorrect ? "correct" : "wrong";

    const gained = computeQuestionScore(isCorrect, t.lockedAtRunMs, state.timeSec);
    t.lastPointsAwarded = gained;
    t.score += gained;
  }

  syncTotalsToTeamsSheet().finally(() => {});
  logAnswersNow().finally(() => {});

  syncTotalsToTeamsSheet().finally(() => {});
  logAnswersNow().finally(() => {});
}

function showLeaderboard() {
  if (state.phase !== "revealed") return;
  state.phase = "leaderboard";
  state.paused = true;
}

function nextQuestion() {
  const total = state.gameQuestions ? state.gameQuestions.length : 0;
  if (state.qIndex >= total - 1) {
    state.phase = "finished";
    state.paused = true;
    return;
  }
  startQuestion(state.qIndex + 1);
}

// auto-reveal when timer hits 0
setInterval(() => {
  if (state.phase !== "question") return;
  if (state.paused) return;
  const rem = getRemainingSec();
  if (rem <= 0) {
    revealAnswer();
    broadcast();
  }
}, 200);

// ------------------- TEAM JOIN / TAKEOVER LOGIC -------------------
function findTeamByPin(pin) {
  const p = String(pin).trim();
  return [...state.teams.values()].find(t => t.pin === p) || null;
}

function clearPendingTakeoverForPin(pin, requesterId = null) {
  const p = String(pin).trim();
  const cur = pendingTakeovers.get(p);
  if (!cur) return;
  if (requesterId && cur.requesterId !== requesterId) return;
  pendingTakeovers.delete(p);
}

function doJoinTeam(socket, enteredPin, teamInfo) {
  const ip = getClientIp(socket);
  const userAgent = getUserAgent(socket);

  const team = {
    id: socket.id,
    pin: enteredPin,
    name: teamInfo.name,
    avatarUrl: teamInfo.avatarUrl,

    // NEW: Members list from Teams sheet. Leader is the first name.
    members: Array.isArray(teamInfo.members) ? teamInfo.members : [],
    leaderName: (Array.isArray(teamInfo.members) && teamInfo.members.length) ? teamInfo.members[0] : "",

    score: 0,
    lockedChoice: null,
    lockedAtRunMs: null,
    lastResult: null,
    lastPointsAwarded: 0,

    // host monitoring fields
    ip,
    userAgent,
    joinedAt: Date.now(),
  };

  state.claimedPins.add(enteredPin);
  state.teams.set(socket.id, team);

  socket.emit("joined", { teamId: team.id, name: team.name, avatarUrl: team.avatarUrl });
  broadcast();
}

function kickTeamSocket(team) {
  if (!team) return;

  const s = io.sockets.sockets.get(team.id);
  if (s) {
    s.emit("kicked", "You were disconnected by the host.");
    s.disconnect(true);
  }

  state.claimedPins.delete(team.pin);
  state.teams.delete(team.id);
}

// ------------------- SOCKETS -------------------
io.on("connection", (socket) => {
  socket.on("registerHost", () => {
    state.hostId = socket.id;
    socket.emit("state", publicState());
    socket.emit("hostState", hostState());
  });

  socket.on("registerProjector", () => {
    state.projectorIds.add(socket.id);
    socket.emit("state", publicState());
  });

  // Team login by PIN (single device)
  socket.on("joinTeam", ({ pin }) => {
    const entered = String(pin || "").trim();
    const teamInfo = TEAM_REGISTRY.find(t => t.pin === entered);
    if (!teamInfo) return socket.emit("joinError", "Invalid team code.");

    if (state.teams.has(socket.id)) {
      return socket.emit("joinError", "This device is already joined.");
    }

    // If already claimed: create takeover request instead of silently failing
    if (state.claimedPins.has(entered)) {
      const ip = getClientIp(socket);
      const userAgent = getUserAgent(socket);

      pendingTakeovers.set(entered, {
        requesterId: socket.id,
        requestedAt: Date.now(),
        ip,
        userAgent
      });

      // Notify requester
      socket.emit("takeoverRequested", {
        message: "This team is already logged in on another device. Waiting for host approval...",
        pin: entered
      });

      // Notify host
      if (state.hostId) {
        io.to(state.hostId).emit("takeoverPending", {
          pin: entered,
          requesterId: socket.id,
          requestedAt: Date.now(),
          ip,
          userAgent
        });
        io.to(state.hostId).emit("hostState", hostState());
      }

      return;
    }

    // Normal join (first device)
    doJoinTeam(socket, entered, teamInfo);
  });

  // Host can kick a team device (free the PIN)
  socket.on("hostKickTeam", ({ teamId, pin }) => {
    if (!isHost(socket)) return;

    let target = null;
    if (teamId) target = state.teams.get(teamId);
    else if (pin) target = findTeamByPin(pin);

    if (!target) return;

    // Also clear any pending takeover request for this pin
    clearPendingTakeoverForPin(target.pin);

    kickTeamSocket(target);
    broadcast();
  });

  // Host approves takeover: kick current device and allow requester to join
  socket.on("hostApproveTakeover", ({ pin }) => {
    if (!isHost(socket)) return;

    const p = String(pin || "").trim();
    const req = pendingTakeovers.get(p);
    if (!req) return;

    const requesterSocket = io.sockets.sockets.get(req.requesterId);
    const currentTeam = findTeamByPin(p);

    // Kick current if still exists
    if (currentTeam) {
      kickTeamSocket(currentTeam);
    } else {
      // if pin is somehow marked claimed but no team, fix it
      state.claimedPins.delete(p);
    }

    // Allow requester to join if still connected
    if (requesterSocket) {
      const teamInfo = TEAM_REGISTRY.find(t => t.pin === p);
      if (!teamInfo) {
        requesterSocket.emit("joinError", "Invalid team code.");
        pendingTakeovers.delete(p);
        broadcast();
        return;
      }

      // Ensure it is not still claimed
      state.claimedPins.delete(p);

      doJoinTeam(requesterSocket, p, teamInfo);
      requesterSocket.emit("takeoverApproved", { message: "Host approved. You are now logged in." });
    }

    pendingTakeovers.delete(p);
    broadcast();
  });

  // Host denies takeover request
  socket.on("hostDenyTakeover", ({ pin }) => {
    if (!isHost(socket)) return;

    const p = String(pin || "").trim();
    const req = pendingTakeovers.get(p);
    if (!req) return;

    const requesterSocket = io.sockets.sockets.get(req.requesterId);
    if (requesterSocket) {
      requesterSocket.emit("takeoverDenied", { message: "Host denied takeover. Try again or ask the host." });
    }

    pendingTakeovers.delete(p);
    broadcast();
  });

  socket.on("lockAnswer", (choiceIndex) => {
    const team = state.teams.get(socket.id);
    if (!team) return;
    if (state.phase !== "question") return;
    if (state.paused) return;
    if (team.lockedChoice != null) return;

    const idx = Number(choiceIndex);
    if (![0, 1, 2, 3].includes(idx)) return;

    team.lockedChoice = idx;
    team.lockedAtRunMs = getRunElapsedMs();
    broadcast();
  });

  // ----- Host game controls -----
  socket.on("hostReset", () => {
    if (!isHost(socket)) return;
    state = resetState();
    pendingTakeovers = new Map();
    broadcast();
  });

  socket.on("hostSetShuffle", ({ shuffleQuestions, shuffleChoices }) => {
    if (!isHost(socket)) return;
    if (typeof shuffleQuestions === "boolean") state.shuffleQuestions = shuffleQuestions;
    if (typeof shuffleChoices === "boolean") state.shuffleChoices = shuffleChoices;
    broadcast();
  });

  socket.on("hostSetManualScoring", (val) => {
    if (!isHost(socket)) return;
    state.manualScoring = !!val;
    broadcast();
  });

  socket.on("hostAdjustScore", ({ teamId, delta }) => {
    if (!isHost(socket)) return;
    const t = state.teams.get(teamId);
    if (!t) return;
    const d = Number(delta);
    if (!Number.isFinite(d)) return;
    t.score += d;
    broadcast();
    syncTotalsToTeamsSheet().finally(() => {});
  });

  socket.on("hostStart", () => {
    if (!isHost(socket)) return;

    if (!Array.isArray(QUESTION_BANK) || QUESTION_BANK.length === 0) {
      socket.emit("hostError", "No questions loaded from the Questions sheet.");
      return;
    }

    state.gameQuestions = buildGameQuestions({
      shuffleQuestions: !!state.shuffleQuestions,
      shuffleChoices: !!state.shuffleChoices
    });

    startQuestion(0);
    broadcast();
  });

  socket.on("hostPauseToggle", () => {
    if (!isHost(socket)) return;
    if (state.phase !== "question") return;
    if (state.paused) resume();
    else pause();
    broadcast();
  });

  socket.on("hostReveal", () => {
    if (!isHost(socket)) return;
    if (state.phase !== "question") return;
    revealAnswer();
    broadcast();
  });

  socket.on("hostNext", () => {
  if (!isHost(socket)) return;

  // revealed -> leaderboard
  if (state.phase === "revealed") {
    showLeaderboard();
    broadcast();
    return;
  }

  // leaderboard -> next question
  if (state.phase === "leaderboard") {
    nextQuestion();
    broadcast();
    return;
  }
});

  socket.on("disconnect", () => {
    if (socket.id === state.hostId) state.hostId = null;
    state.projectorIds.delete(socket.id);

    // If a logged-in team disconnects, free its pin
    const team = state.teams.get(socket.id);
    if (team) {
      state.claimedPins.delete(team.pin);
      state.teams.delete(socket.id);
      // Also clear pending takeover for that pin (optional)
      clearPendingTakeoverForPin(team.pin);
    }

    // If a takeover requester disconnects, remove its request
    for (const [pin, req] of pendingTakeovers.entries()) {
      if (req.requesterId === socket.id) pendingTakeovers.delete(pin);
    }

    broadcast();
  });

  socket.emit("state", publicState());
});

// ------------------- BOOTSTRAP -------------------
async function loadSheetDataOrExitIfBroken() {
  const teams = await loadTeamsFromSheet();
  TEAM_REGISTRY = teams.map(t => ({ 
    pin: t.pin, 
    name: t.name, 
    avatarUrl: t.avatarUrl || "", 
    members: Array.isArray(t.members) ? t.members:[] }));

  const questions = await loadQuestionsFromSheet();
  QUESTION_BANK = questions;

  console.log(`✅ Loaded ${TEAM_REGISTRY.length} teams from Teams sheet.`);
  console.log(`✅ Loaded ${QUESTION_BANK.length} questions from Questions sheet.`);
}

async function main() {
  try {
    await loadSheetDataOrExitIfBroken();
  } catch (err) {
    console.error("❌ Failed to load data from Google Sheets:", err.message || err);
    console.error("   Fix the sheet headers/data and restart the server.");
    process.exit(1);
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Mini Kahoot running on http://localhost:${PORT}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
