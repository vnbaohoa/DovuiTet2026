// sheets_store.js
// Google Sheets = source of truth for Teams + Questions, and logs (QuestionLog/AnswerLog)

const { google } = require("googleapis");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getAuthFromEnv() {
  // Preferred for Render:
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64) {
    const jsonStr = Buffer.from(b64, "base64").toString("utf8");
    const creds = JSON.parse(jsonStr);
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

// Optional fallback for local dev (if you still use a file locally):
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (keyPath) {
    return new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 (recommended) or GOOGLE_SERVICE_ACCOUNT_JSON (local file).");
}

async function getSheetsClient() {
  const auth = getAuth();
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

function toBool(x) {
  const s = String(x ?? "").trim().toLowerCase();
  if (!s) return true; // default enabled if blank
  return ["true", "yes", "y", "1"].includes(s);
}

function toInt(x, fallback) {
  const n = Number(String(x ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeCorrectLetter(x) {
  const s = String(x ?? "").trim().toUpperCase();
  if (["A", "B", "C", "D"].includes(s)) return s;
  return "";
}

async function loadTeamsFromSheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = mustEnv("SHEET_ID");
  const sheetName = process.env.TEAMS_SHEET_NAME || "Teams";
  // Expected columns (headers in row 1):
  // pin | name | avatarUrl | members | score
  const range = `${sheetName}!A1:Z`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || "").trim().toLowerCase());
  const idxPin = headers.indexOf("Pin");
  const idxName = headers.indexOf("Name");
  const idxAvatar = headers.indexOf("avatarUrl");
  // Allow either "members" or "member" as the header name (your sheet uses "member")
  const idxMembers = headers.indexOf("Members") !== -1 ? headers.indexOf("members") : headers.indexOf("member");
  const idxScore = headers.indexOf("score");

  if (idxPin === -1 || idxName === -1) {
    throw new Error(
      `Teams sheet must have headers: pin, name (optional: avatarUrl, members, score). Found: ${rows[0].join(", ")}`
    );
  }

  const teams = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pin = String(r[idxPin] || "").trim();
    const name = String(r[idxName] || "").trim();
    if (!pin || !name) continue;

    const avatarUrl = idxAvatar !== -1 ? String(r[idxAvatar] || "").trim() : "";
    const score = idxScore !== -1 ? Number(r[idxScore] || 0) : 0;

    const membersRaw = idxMembers !== -1 ? String(r[idxMembers] || "").trim() : "";
    const members = membersRaw
      ? membersRaw.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    teams.push({ pin, name, avatarUrl, members, score });
  }
  return teams;
}

async function loadQuestionsFromSheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = mustEnv("SHEET_ID");
  const sheetName = process.env.QUESTIONS_SHEET_NAME || "Questions";
  const range = `${sheetName}!A1:K`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || "").trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const iQid = idx("qid");
  const iQuestion = idx("question");
  const iMediaType = idx("mediatype");
  const iMediaUrl = idx("mediaurl");
  const iA = idx("a");
  const iB = idx("b");
  const iC = idx("c");
  const iD = idx("d");
  const iCorrect = idx("correct");
  const iTimeSec = idx("timesec");
  const iEnabled = idx("enabled");

  if (iQuestion === -1 || iA === -1 || iB === -1 || iC === -1 || iD === -1 || iCorrect === -1) {
    throw new Error(
      `Questions sheet headers required: question, A, B, C, D, correct (optional: qId, mediaType, mediaUrl, timeSec, enabled). Found: ${rows[0].join(", ")}`
    );
  }

  const questions = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const enabled = iEnabled !== -1 ? toBool(row[iEnabled]) : true;
    if (!enabled) continue;

    const question = String(row[iQuestion] || "").trim();
    const A = String(row[iA] || "").trim();
    const B = String(row[iB] || "").trim();
    const C = String(row[iC] || "").trim();
    const D = String(row[iD] || "").trim();
    const correctLetter = normalizeCorrectLetter(row[iCorrect]);
    const timeSec = iTimeSec !== -1 ? toInt(row[iTimeSec], 20) : 20;

    if (!question) continue;
    if (![A, B, C, D].every(x => x.length > 0)) continue;
    if (!correctLetter) continue;

    const correctIndex = { A: 0, B: 1, C: 2, D: 3 }[correctLetter];
    const qIdRaw = iQid !== -1 ? String(row[iQid] || "").trim() : "";
    const qId = qIdRaw || `ROW-${r + 1}`;

    const mediaTypeRaw = iMediaType !== -1 ? String(row[iMediaType] || "").trim().toLowerCase() : "";
    const mediaType = (mediaTypeRaw === "image" || mediaTypeRaw === "video") ? mediaTypeRaw : "";
    const mediaUrl = iMediaUrl !== -1 ? String(row[iMediaUrl] || "").trim() : "";

    const qObj = {
      qId,
      text: question,
      choices: [A, B, C, D],
      correctIndex,
      timeSec: Math.max(5, Math.min(300, timeSec)),
    };

    if (mediaType && mediaUrl) {
      qObj.mediaType = mediaType;
      qObj.mediaUrl = mediaUrl;
    }

    questions.push(qObj);
  }

  return questions;
}

async function updateScoresToSheet(pinToScore) {
  const sheets = await getSheetsClient();
  const spreadsheetId = mustEnv("SHEET_ID");
  const sheetName = process.env.TEAMS_SHEET_NAME || "Teams";
  const range = `${sheetName}!A1:D`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (rows.length < 2) return { updated: 0 };

  const headers = rows[0].map(h => String(h || "").trim().toLowerCase());
  const idxPin = headers.indexOf("pin");
  let idxScore = headers.indexOf("score");
  if (idxPin === -1) throw new Error(`Teams sheet must have 'pin' header.`);
  if (idxScore === -1) idxScore = 3; // default to column D if missing

  const data = [];
  let updated = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pin = String(r[idxPin] || "").trim();
    if (!pin) continue;

    if (Object.prototype.hasOwnProperty.call(pinToScore, pin)) {
      const score = pinToScore[pin];
      const rowNumber = i + 1;
      const colLetter = String.fromCharCode("A".charCodeAt(0) + idxScore);
      const cell = `${sheetName}!${colLetter}${rowNumber}`;
      data.push({ range: cell, values: [[String(score)]] });
      updated++;
    }
  }

  if (!data.length) return { updated: 0 };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });

  return { updated };
}

async function appendRows(sheetName, rows) {
  if (!rows || rows.length === 0) return { appended: 0 };
  const sheets = await getSheetsClient();
  const spreadsheetId = mustEnv("SHEET_ID");

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return { appended: rows.length };
}

async function appendQuestionRow(row) {
  const sheetName = process.env.QUESTION_LOG_SHEET_NAME || "QuestionLog";
  return appendRows(sheetName, [row]);
}

async function appendAnswerRows(rows) {
  const sheetName = process.env.ANSWER_LOG_SHEET_NAME || "AnswerLog";
  return appendRows(sheetName, rows);
}

module.exports = {
  loadTeamsFromSheet,
  loadQuestionsFromSheet,
  updateScoresToSheet,
  appendQuestionRow,
  appendAnswerRows,
};
