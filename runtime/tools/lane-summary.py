#!/usr/bin/env python3
"""Summarise compare-lanes logs for an A/B: one row per log.

    python3 tools/lane-summary.py build/compare/picb-*/picb-*.log

Reads what the tools print (LANES_GREP must keep framesplit, entitytick,
fly and, for the compile columns, "compile time" and "slow install"; the
page needs ?frameSplit=1, and ?stdoutconsole=1 with
jitflags=-XX:%2BZeroWasmJITPrintCompileTime for the compile lines):

- world hitches: hitches, over100 and worst frame in the measured minute
- steady: framesplit tick ms, tickFrame p50/p90, plainFrame p90 and
  entitytick ms, averaged over the last 10 framesplit lines (one tag only,
  each line is printed twice)
- flight: meanReady and zeroReady
- client compiles (thread main) in the first 20 s in world: total ms,
  slowest single compile ms, and the reasons summed (new/dependent/sweep/
  bails/profile); slow installs over the whole run
"""
import json
import re
import sys

NUM = r"([0-9.]+)"


def avg(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def summarise(path):
    text = open(path, errors="replace").read().splitlines()
    row = {"log": path}
    in_world = None
    fs, et = [], []
    ct = []
    slow = 0
    for line in text:
        m = re.search(r"inWorld: " + NUM, line)
        if m:
            in_world = float(m.group(1))
        if line.startswith("world hitches:"):
            row["world"] = json.loads(line.split(":", 1)[1])
        if line.startswith("fly: {"):
            try:
                row["fly"] = json.loads(line[5:])
            except ValueError:
                pass
        if "[MC-STAGE]" in line and "framesplit:" in line:
            m = re.search(r"tickFrame\[p50=" + NUM + r" p90=" + NUM + r"\] plainFrame\[p50="
                          + NUM + r" p90=" + NUM + r"\] \| per tick ms: tick=" + NUM, line)
            if m:
                fs.append([float(x) for x in m.groups()])
        if "[MC-STAGE]" in line and "entitytick:" in line:
            m = re.search(r" tick=" + NUM + r" entities=(\d+)", line)
            if m:
                et.append((float(m.group(1)), int(m.group(2))))
        if "[zwc] slow install" in line:
            slow += 1
        if "[zwc] compile time" in line and "| thread main" in line:
            t = re.match(r"\[" + NUM + r"\]", line)
            m = re.search(r"compile time " + NUM + r" ms .*slowest " + NUM
                          + r" ms .*why: new (\d+) dependent (\d+) sweep (\d+) bails (\d+) profile (\d+)", line)
            if t and m:
                ct.append((float(t.group(1)), float(m.group(1)), float(m.group(2)),
                           [int(x) for x in m.groups()[2:]]))
    last = fs[-10:]
    row["steady"] = {
        "tick": avg([f[4] for f in last]),
        "tickP50": avg([f[0] for f in last]),
        "tickP90": avg([f[1] for f in last]),
        "plainP90": avg([f[3] for f in last]),
        "entity": avg([e[0] for e in et[-10:]]),
        "entities": avg([e[1] for e in et[-10:]]),
    }
    if in_world is not None:
        early = [c for c in ct if in_world <= c[0] < in_world + 20]
        why = [sum(c[3][i] for c in early) for i in range(5)]
        row["compiles20s"] = {
            "ms": sum(c[1] for c in early),
            "slowest": max((c[2] for c in early), default=0.0),
            "why": dict(zip(["new", "dependent", "sweep", "bails", "profile"], why)),
        }
    row["slowInstalls"] = slow
    return row


def main():
    rows = [summarise(p) for p in sys.argv[1:]]
    hdr = ("log", "hitch", ">100", "worst", "tick", "p50", "p90", "plain90", "entity",
           "ready", "zero", "ct20ms", "ct20max", "slowInst", "why20 n/d/s/b/p")
    print("\t".join(hdr))
    for r in rows:
        w, s, f, c = r.get("world", {}), r["steady"], r.get("fly", {}), r.get("compiles20s", {})
        why = c.get("why", {})
        print("\t".join(str(x) for x in (
            r["log"].split("/")[-1], w.get("hitches"), w.get("over100"), w.get("worst"),
            f"{s['tick']:.2f}", f"{s['tickP50']:.1f}", f"{s['tickP90']:.1f}", f"{s['plainP90']:.1f}",
            f"{s['entity']:.2f}", f.get("meanReady"), f.get("zeroReady"),
            f"{c.get('ms', float('nan')):.0f}", f"{c.get('slowest', float('nan')):.1f}",
            r["slowInstalls"], "/".join(str(why.get(k, "-")) for k in
                                        ("new", "dependent", "sweep", "bails", "profile")))))


if __name__ == "__main__":
    main()
