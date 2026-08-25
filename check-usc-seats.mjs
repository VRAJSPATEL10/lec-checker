#!/usr/bin/env node
/**
 * Polls the USC Schedule of Classes API for watched courses and sends an
 * ntfy.sh push when a linkCode group flips from closed -> open.
 *
 * Config: usc-watch.json
 * State:  usc-state.json (auto-managed)
 *
 * Run locally with:
 *   NTFY_TOPIC=... node check-usc-seats.mjs
 *   node check-usc-seats.mjs --dry-run   # no ntfy, no state write
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

function groupKey(term, course, linkCode) {
  return `${term}|${course}|${linkCode}`;
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

// Return the current status of a single linkCode group for a course.
// A group is "open" iff every section is non-cancelled AND has >0 open seats.
function evaluateGroup(course, linkCode) {
  const sections = (course.sections || []).filter(
    (s) => s.linkCode === linkCode
  );
  if (sections.length === 0) return null;

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
  const instructor = (() => {
    const lec = sections.find((s) => s.rnrMode === "Lecture") || sections[0];
    const i = (lec.instructors || [])[0];
    return i ? `${i.firstName} ${i.lastName}`.trim() : null;
  })();
  const schedule = (() => {
    const lec = sections.find((s) => s.rnrMode === "Lecture") || sections[0];
    const sched = (lec.schedule || [])[0];
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

function buildBody(watch, group) {
  const lines = [];
  lines.push(`${group.openSeats} seat(s) open in ${watch.course} link ${watch.linkCode || "?"}`);
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

async function main() {
  const config = loadConfig();
  const topic = process.env.NTFY_TOPIC;
  if (!topic && !DRY_RUN) {
    throw new Error("Missing NTFY_TOPIC env var (or pass --dry-run)");
  }

  const state = loadState();
  const isFirstRun = Object.keys(state.groups || {}).length === 0;
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

      const requestedLinks = Array.isArray(w.linkCodes) && w.linkCodes.length
        ? w.linkCodes
        : w.linkCode
        ? [w.linkCode]
        : Array.from(new Set((course.sections || []).map((s) => s.linkCode)));

      for (const link of requestedLinks) {
        if (config.excludeDenLinkCode && link === "D" && !(w.linkCodes || [w.linkCode]).includes("D")) {
          continue;
        }
        const group = evaluateGroup(course, link);
        if (!group) {
          console.warn(`No sections for ${w.course} link ${link}`);
          continue;
        }
        const gk = groupKey(term, w.course, link);
        const prev = state.groups?.[gk];
        nextGroups[gk] = {
          isOpen: group.isOpen,
          openSeats: group.openSeats,
          sections: group.sections.map((s) => ({
            id: s.id,
            type: s.type,
            total: s.total,
            registered: s.registered,
          })),
        };
        console.log(
          `${w.course} link ${link}: ${group.isOpen ? `OPEN (${group.openSeats})` : "closed"}` +
            (prev ? ` (was ${prev.isOpen ? `open ${prev.openSeats}` : "closed"})` : " (first seen)")
        );
        if (!isFirstRun && shouldNotify(config.notifyMode, prev, group)) {
          notifications.push({
            watch: { ...w, linkCode: link },
            group,
            title: `${w.course} (${link}): ${group.openSeats} seat${group.openSeats === 1 ? "" : "s"} open`,
            click: courseLink(term, w.course),
          });
        }
      }
    }
  }

  const nextState = {
    groups: nextGroups,
    updatedAt: new Date().toISOString(),
  };

  if (DRY_RUN) {
    console.log("--- DRY RUN ---");
    console.log(`Would save state with ${Object.keys(nextGroups).length} group(s).`);
    console.log(`Would send ${notifications.length} notification(s):`);
    for (const n of notifications) {
      console.log(`  ${n.title}`);
      console.log(buildBody(n.watch, n.group).split("\n").map((l) => `    ${l}`).join("\n"));
    }
    return;
  }

  saveState(nextState);

  if (isFirstRun) {
    console.log(
      `Baseline set with ${Object.keys(nextGroups).length} group(s). No notification on first run.`
    );
    return;
  }

  for (const n of notifications) {
    await sendNtfy(topic, n.title, buildBody(n.watch, n.group), n.click);
    console.log(`Notified: ${n.title}`);
  }
  if (notifications.length === 0) {
    console.log("No new openings.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
