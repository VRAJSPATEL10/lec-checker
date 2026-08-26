#!/usr/bin/env node
/**
 * Polls the USC Schedule of Classes API for watched courses and sends an
 * ntfy.sh push when a section (or linkCode group) flips from closed -> open.
 *
 * Two watch styles supported:
 *   1. `linkCodes: ["A"]`   - for regular courses where Lecture+Lab (or Lec+Dis+Quiz)
 *                             are bundled together by USC via linkCode.
 *   2. `sectionIds: ["30327"]` - for Special Topics courses (599, 496, 490)
 *                                where each section is a standalone class with
 *                                linkCode: null and a distinct `name`.
 *
 * Run modes:
 *   - One-shot (default): runs once, uses usc-state.json for state.
 *                         Used by GitHub Actions cron.
 *   - Loop:  set POLL_INTERVAL_SEC=<n> to loop forever with in-memory state.
 *            Used by long-running deployments (Fly.io, Docker, systemd).
 *            State is lost on restart => first iteration is a silent baseline.
 *
 * Config: usc-watch.json
 * State:  usc-state.json (auto-managed; only used in one-shot mode)
 *
 * Run locally with:
 *   NTFY_TOPIC=... node check-usc-seats.mjs
 *   node check-usc-seats.mjs --dry-run           # no ntfy, no state write
 *   POLL_INTERVAL_SEC=10 node check-usc-seats.mjs   # loop mode, every 10s
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "usc-watch.json");
const STATE_PATH = join(HERE, "usc-state.json");
const API_BASE = "https://classes.usc.edu/api/Search/Basic";
const DRY_RUN = process.argv.includes("--dry-run");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!Array.isArray(cfg.watches) || cfg.watches.length === 0) {
    throw new Error("usc-watch.json has no watches");
  }
  return {
    notifyMode: cfg.notifyMode || "on_open",
    excludeDenLinkCode: cfg.excludeDenLinkCode !== false,
    watches: cfg.watches,
  };
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { groups: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function courseLink(term, courseName) {
  const q = encodeURIComponent(courseName);
  return `https://classes.usc.edu/term/${term}/catalogue/search?searchphrase=${q}`;
}

async function fetchSubject(term, subject) {
  const url = `${API_BASE}?termCode=${term}&searchTerm=${subject}&t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} for ${subject}/${term}`);
  }
  return res.json();
}

// Given a raw list of section objects (from the USC API), return an
// aggregated status. A group is "open" iff every section is non-cancelled
// AND has >0 open seats.
function evaluateGroup(sections) {
  if (!sections || sections.length === 0) return null;

  let isOpen = true;
  let minOpen = Infinity;
  const snapshot = sections.map((s) => {
    const total = Number(s.totalSeats) || 0;
    const registered = Number(s.registeredSeats) || 0;
    const open = Math.max(0, total - registered);
    const cancelled = s.isCancelled === true;
    if (cancelled || open === 0) isOpen = false;
    if (open < minOpen) minOpen = open;
    return {
      id: s.sisSectionId,
      type: s.rnrMode,
      total,
      registered,
      open,
      cancelled,
      dClearance: s.hasDClearance === true,
    };
  });

  const anyDClearance = snapshot.some((s) => s.dClearance);
  const primary = sections.find((s) => s.rnrMode === "Lecture") || sections[0];
  const instructor = (() => {
    const i = (primary.instructors || [])[0];
    return i ? `${i.firstName} ${i.lastName}`.trim() : null;
  })();
  const schedule = (() => {
    const sched = (primary.schedule || [])[0];
    if (!sched) return null;
    const days = Array.isArray(sched.days) ? sched.days.join("/") : "";
    return `${days} ${sched.startTime}-${sched.endTime}`.trim();
  })();

  return {
    isOpen,
    openSeats: isOpen ? minOpen : 0,
    sections: snapshot,
    dClearance: anyDClearance,
    instructor,
    schedule,
    name: primary.name || null,
  };
}

function shouldNotify(mode, prev, curr) {
  if (!curr.isOpen) return false;
  if (mode === "always_if_open") return true;
  if (mode === "any_change") {
    return !prev || prev.openSeats !== curr.openSeats;
  }
  return !prev || prev.isOpen !== true;
}

function buildBody(watch, group, label) {
  const lines = [];
  const header = group.name
    ? `${group.openSeats} seat(s) open in ${watch.course}: ${group.name}`
    : `${group.openSeats} seat(s) open in ${watch.course} ${label}`;
  lines.push(header);
  if (group.instructor) lines.push(`Instructor: ${group.instructor}`);
  if (group.schedule) lines.push(`Schedule: ${group.schedule}`);
  if (group.dClearance) {
    lines.push("Requires D-clearance (department permission)");
  }
  lines.push("");
  lines.push("Sections:");
  for (const s of group.sections) {
    const flag = s.cancelled ? " [cancelled]" : s.dClearance ? " [D]" : "";
    lines.push(`  ${s.id} ${s.type}: ${s.registered}/${s.total}${flag}`);
  }
  lines.push("");
  lines.push("Open WebReg: https://webreg.usc.edu/");
  return lines.join("\n");
}

async function sendNtfy(topic, title, body, clickUrl) {
  const base = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  const headers = {
    Title: title,
    Priority: "high",
    Tags: "school,bell",
    Click: clickUrl,
  };
  if (process.env.NTFY_TOKEN) {
    headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  }
  const res = await fetch(`${base}/${topic}`, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ntfy failed (${res.status}): ${text}`);
  }
}

// Process one evaluated group: log, record next state, maybe queue notification.
function processGroup(ctx, gk, group, labelForLog, titleSuffix, watchLabel, extraWatchFields) {
  const { state, nextGroups, notifications, isFirstRun, config, term, w } = ctx;
  const prev = state.groups?.[gk];
  nextGroups[gk] = {
    isOpen: group.isOpen,
    openSeats: group.openSeats,
    sections: group.sections.map((s) => ({
      id: s.id, type: s.type, total: s.total, registered: s.registered,
    })),
  };
  console.log(
    `${w.course} ${labelForLog}: ${group.isOpen ? `OPEN (${group.openSeats})` : "closed"}` +
      (prev ? ` (was ${prev.isOpen ? `open ${prev.openSeats}` : "closed"})` : " (first seen)")
  );
  if (!isFirstRun && shouldNotify(config.notifyMode, prev, group)) {
    notifications.push({
      watch: { ...w, ...extraWatchFields },
      group,
      label: watchLabel,
      title: `${w.course}${titleSuffix}: ${group.openSeats} seat${group.openSeats === 1 ? "" : "s"} open`,
      click: courseLink(term, w.course),
    });
  }
}

// Do one pass over all watches. Pure function of (config, state) — no I/O
// beyond the USC API fetch and no ntfy sending. Returns the new state and any
// notifications that should be dispatched by the caller.
async function runIteration(config, state, isFirstRun) {
  const nextGroups = {};
  const notifications = [];

  // Batch by (term, subject) so we make one API call per subject even if you
  // watch several courses in that subject.
  const bySubject = new Map();
  for (const w of config.watches) {
    const key = `${w.term}|${w.subject.toLowerCase()}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(w);
  }

  for (const [key, watches] of bySubject) {
    const [term, subject] = key.split("|");
    let payload;
    try {
      payload = await fetchSubject(term, subject);
    } catch (err) {
      console.error(`Fetch failed for ${subject}/${term}:`, err.message);
      continue;
    }

    for (const w of watches) {
      const course = (payload.courses || []).find(
        (c) => c.fullCourseName === w.course
      );
      if (!course) {
        console.warn(`Course not found: ${w.course} in ${subject}/${term}`);
        continue;
      }

      const ctx = { state, nextGroups, notifications, isFirstRun, config, term, w };

      // ---- Section-ID mode (Special Topics: 599, 496, 490 etc.) ----
      if (Array.isArray(w.sectionIds) && w.sectionIds.length) {
        for (const sid of w.sectionIds) {
          const section = (course.sections || []).find(
            (s) => s.sisSectionId === sid
          );
          if (!section) {
            console.warn(`Section not found: ${w.course} #${sid}`);
            continue;
          }
          const group = evaluateGroup([section]);
          const gk = `${term}|${w.course}|section:${sid}`;
          const labelForLog = group.name ? `— ${group.name}` : `#${sid}`;
          const titleSuffix = group.name ? ` — ${group.name}` : ` #${sid}`;
          processGroup(ctx, gk, group, labelForLog, titleSuffix, `section ${sid}`, { sectionId: sid });
        }
        continue;
      }

      // ---- linkCode mode (regular courses with Lec+Lab bundles) ----
      const requestedLinks = Array.isArray(w.linkCodes) && w.linkCodes.length
        ? w.linkCodes
        : w.linkCode
        ? [w.linkCode]
        : Array.from(
            new Set((course.sections || []).map((s) => s.linkCode).filter(Boolean))
          );

      for (const link of requestedLinks) {
        if (
          config.excludeDenLinkCode &&
          link === "D" &&
          !(w.linkCodes || [w.linkCode]).includes("D")
        ) {
          continue;
        }
        const sections = (course.sections || []).filter(
          (s) => s.linkCode === link
        );
        const group = evaluateGroup(sections);
        if (!group) {
          console.warn(`No sections for ${w.course} link ${link}`);
          continue;
        }
        const gk = `${term}|${w.course}|${link}`;
        processGroup(ctx, gk, group, `link ${link}`, ` (${link})`, `link ${link}`, { linkCode: link });
      }
    }
  }

  return {
    nextState: {
      groups: nextGroups,
      updatedAt: new Date().toISOString(),
    },
    notifications,
  };
}

async function dispatchNotifications(topic, notifications) {
  for (const n of notifications) {
    await sendNtfy(topic, n.title, buildBody(n.watch, n.group, n.label), n.click);
    console.log(`Notified: ${n.title}`);
  }
}

function printDryRun(nextState, notifications) {
  console.log("--- DRY RUN ---");
  console.log(`Would save state with ${Object.keys(nextState.groups).length} group(s).`);
  console.log(`Would send ${notifications.length} notification(s):`);
  for (const n of notifications) {
    console.log(`  ${n.title}`);
    console.log(
      buildBody(n.watch, n.group, n.label)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
    );
  }
}

// One-shot: reads state from disk, runs once, saves state, sends pushes.
// Used by GitHub Actions cron.
async function runOneShot(config, topic) {
  const state = loadState();
  const isFirstRun = Object.keys(state.groups || {}).length === 0;
  const { nextState, notifications } = await runIteration(config, state, isFirstRun);

  if (DRY_RUN) {
    printDryRun(nextState, notifications);
    return;
  }

  saveState(nextState);

  if (isFirstRun) {
    console.log(
      `Baseline set with ${Object.keys(nextState.groups).length} group(s). No notification on first run.`
    );
    return;
  }

  await dispatchNotifications(topic, notifications);
  if (notifications.length === 0) {
    console.log("No new openings.");
  }
}

// Loop mode: state lives in memory across iterations. Used by long-running
// deployments (Fly.io, Docker, systemd). Set POLL_INTERVAL_SEC to enable.
async function runLoop(config, topic, intervalSec) {
  console.log(`Loop mode: polling every ${intervalSec}s.`);
  let state = { groups: {} };
  let isFirstRun = true;

  while (true) {
    const startedAt = new Date().toISOString();
    try {
      const { nextState, notifications } = await runIteration(config, state, isFirstRun);
      state = nextState;

      if (isFirstRun) {
        console.log(
          `[${startedAt}] Baseline set with ${Object.keys(state.groups).length} group(s).`
        );
      } else if (DRY_RUN) {
        printDryRun(state, notifications);
      } else if (notifications.length > 0) {
        await dispatchNotifications(topic, notifications);
      } else {
        console.log(`[${startedAt}] No new openings.`);
      }
      isFirstRun = false;
    } catch (err) {
      console.error(`[${startedAt}] Iteration failed:`, err);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

async function main() {
  const config = loadConfig();
  const topic = process.env.NTFY_TOPIC;
  if (!topic && !DRY_RUN) {
    throw new Error("Missing NTFY_TOPIC env var (or pass --dry-run)");
  }

  const intervalSec = parseInt(process.env.POLL_INTERVAL_SEC, 10) || 0;
  if (intervalSec > 0) {
    await runLoop(config, topic, intervalSec);
  } else {
    await runOneShot(config, topic);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
