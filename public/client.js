// public/client.js
const socket = io();

function $(id) {
  return document.getElementById(id);
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function letter(i) {
  return ["A", "B", "C", "D"][i] || "";
}

function shortUA(ua = "") {
  ua = String(ua);
  return ua.length > 60 ? ua.slice(0, 60) + "…" : ua;
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString();
}
