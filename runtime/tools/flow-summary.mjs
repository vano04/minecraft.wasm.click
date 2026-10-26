#!/usr/bin/env node
// Summarises the `flow` lines compare-lanes --fly prints: how steadily
// chunks reached the client while flying.
//   node tools/flow-summary.mjs build/compare/<run>.log ...
//
// `client` is net of the chunks dropped behind the player, so a second in
// which chunks arrived and as many were dropped reads as a wait. The same
// gap/burst measure is therefore also taken on `earlySent` (cumulative
// chunks the port's early send queued: arrivals the client will get, though
// vanilla's own ticking-chunk sends are not in it) and on `serverFull`
// (FULL chunks in view, again net). `serverTick` stuck for >= 2 s is a
// server freeze, reported on its own.
import { readFileSync } from "node:fs";
const num = (l, k) => { const m = l.match(new RegExp("\\b" + k + "=(\\d+)")); return m ? +m[1] : NaN; };
function gaps(rows, key) {
  let arrivals = 0, arrivalSeconds = 0, longestGap = 0, longestAt = 0, gapStart = rows[0]?.t ?? 0, biggest = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i][key] - rows[i - 1][key];
    if (d > 0) {
      arrivals += d; arrivalSeconds++; biggest = Math.max(biggest, d);
      if (rows[i].t - gapStart > longestGap) { longestGap = rows[i].t - gapStart; longestAt = gapStart; }
      gapStart = rows[i].t;
    }
  }
  const tail = rows.length ? rows[rows.length - 1].t - gapStart : 0;
  if (tail > longestGap) { longestGap = tail; longestAt = gapStart; }
  return { arrivals, arrivalSeconds, longestGap: Math.round(longestGap), longestAt: Math.round(longestAt), biggest };
}
for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("flow "))
    .map((l) => ({ t: parseFloat(l.split(" ")[1]), client: num(l, "client"), sent: num(l, "earlySent"),
      full: num(l, "serverFull"), tick: num(l, "serverTick") }));
  const span = rows.length ? rows[rows.length - 1].t - rows[0].t : 0;
  const c = gaps(rows, "client");
  console.log(`${file}: ${Math.round(span)} s, ${c.arrivals} chunks arrived in ${c.arrivalSeconds} seconds, `
    + `longest wait ${c.longestGap} s, biggest burst ${c.biggest}`);
  const s = gaps(rows.filter((r) => !isNaN(r.sent)), "sent");
  const f = gaps(rows.filter((r) => !isNaN(r.full)), "full");
  let freeze = 0, freezeAt = 0, from = rows[0];
  for (const r of rows) {
    if (isNaN(r.tick)) continue;
    if (r.tick !== from.tick) from = r;
    else if (r.t - from.t > freeze) { freeze = r.t - from.t; freezeAt = from.t; }
  }
  console.log(`  client: longest wait ${c.longestGap} s at t=${c.longestAt}; `
    + `earlySent: ${s.arrivals} sent, longest wait ${s.longestGap} s at t=${s.longestAt}, biggest burst ${s.biggest}; `
    + `serverFull: longest flat ${f.longestGap} s at t=${f.longestAt}, biggest jump ${f.biggest}; `
    + `serverTick: longest freeze ${Math.round(freeze)} s${freeze >= 2 ? " at t=" + Math.round(freezeAt) : ""}`);
}
