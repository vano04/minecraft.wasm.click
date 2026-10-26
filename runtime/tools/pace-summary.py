#!/usr/bin/env python3
"""Summarise ?mcweb_pace=1 lines from compare-lanes logs, split into phases.

usage: tools/pace-summary.py <log> [<log>...]

Run compare-lanes with LANES_GREP='pace:|vsync:|pacing:|fly' so the lines
reach its stdout. Phases come from the log's own markers: "stand" starts at
the "inWorld:" line, "fly" at the first line that mentions the flight.
  pace:   the GPU worker's frame-arrival gaps (one line a second)
  vsync:  new frames per GPU-worker animation frame (fresh0 = a repeat)
"""
import re
import sys


def parse(path):
    rows, phase, events = [], "boot", []
    for line in open(path, errors="replace"):
        if line.startswith("inWorld:"):
            phase = "stand"
            events.append(line.strip())
            continue
        m = re.match(r"\[([\d.]+)\] (.*)", line)
        if not m:
            if phase == "stand" and re.match(r"fly", line):
                phase = "fly"
                events.append(line.strip()[:120])
            continue
        t, body = float(m.group(1)), m.group(2)
        if "vsync:" in body and "fresh0" in body:
            kv = dict(re.findall(r"(\w+)=([\d.]+)", body))
            rows.append((t, phase, {"vs": 1, **{k: float(v) for k, v in kv.items()}}))
            continue
        if "pace:" not in body:
            if phase == "stand" and re.search(r"\bfly", body):
                events.append(f"[{t}] {body[:100]}")
                phase = "fly"
            continue
        kv = dict(re.findall(r"(\w+)=([\d.]+)", body))
        rows.append((t, phase, {k: float(v) for k, v in kv.items()}))
    return rows, events


def vsummary(rows):
    rows = [r for r in rows if r[2].get("vs")]
    if not rows:
        return "no vsync data"
    f = [sum(r[2][k] for r in rows) for k in ("fresh0", "fresh1", "fresh2")]
    tot = sum(f)
    hz = sorted(r[2]["hz"] for r in rows)[len(rows) // 2]
    return (f"vsync hz={hz:.1f} refreshes={tot:.0f} repeated(fresh0)={100*f[0]/tot:.1f}% "
            f"one={100*f[1]/tot:.1f}% dropped(fresh2+)={100*f[2]/tot:.1f}%")


def summary(rows):
    rows = [r for r in rows if not r[2].get("vs")]
    if not rows:
        return "no data"
    n = sum(r["n"] for _, _, r in rows)
    secs = len(rows)
    agg = {k: sum(r.get(k, 0) for _, _, r in rows) for k in ("over20", "over33", "over50", "spikes", "sumOver2x")}
    p99 = sorted(r["p99"] for _, _, r in rows)
    p50 = sorted(r["p50"] for _, _, r in rows)
    mx = max(r["max"] for _, _, r in rows)
    return (f"secs={secs} frames={n:.0f} fps={n/secs:.1f} p50(med)={p50[len(p50)//2]:.1f} "
            f"p99(med)={p99[len(p99)//2]:.1f} p99(worst sec)={p99[-1]:.1f} max={mx:.0f} | per 100 frames: "
            f"over20={100*agg['over20']/n:.2f} over33={100*agg['over33']/n:.2f} over50={100*agg['over50']/n:.2f} "
            f"spikes(>2x med)={100*agg['spikes']/n:.2f} | spike ms/s={agg['sumOver2x']/secs:.0f}")


for path in sys.argv[1:]:
    rows, events = parse(path)
    print(f"== {path}")
    for e in events:
        print("   ", e)
    for ph in ("boot", "stand", "fly"):
        sel = [r for r in rows if r[1] == ph]
        print(f"  {ph:5} {summary(sel)}")
        print(f"        {vsummary(sel)}")
