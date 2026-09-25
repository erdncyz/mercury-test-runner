// QA skills: Markdown playbooks that give the chat QA agent a senior tester's know-how. Each file has a small
// front matter (name, description, triggers, always). `always: true` skills go into every plan; the others only
// when one of their trigger words starts a word of the tester's sentence (or a recent turn), so the prompt stays
// focused. Built-in skills live in `skills/`; an installation can add or override them in `<DATA_DIR>/skills/`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fold } from "./agent.mjs";

export const SKILL_BUDGET = 24_000;

export function parseSkill(text, id = "") {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta = {};
  for (const line of (match?.[1] || "").split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (pair) meta[pair[1].toLowerCase()] = pair[2].trim();
  }
  const body = (match ? match[2] : raw).trim();
  return {
    id,
    name: meta.name || id,
    description: meta.description || "",
    always: /^(true|yes|evet|1)$/i.test(meta.always || ""),
    triggers: [...new Set(String(meta.triggers || "").split(",").map((item) => fold(item)).filter(Boolean))],
    body,
  };
}

// Later directories override earlier ones by file name, so an installation can replace a built-in skill.
export function loadSkills(dirs) {
  const byId = new Map();
  for (const [index, dir] of dirs.entries()) {
    if (!dir || !existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const id = basename(file, ".md");
      try {
        const skill = parseSkill(readFileSync(join(dir, file), "utf8"), id);
        if (skill.body) byId.set(id, { ...skill, source: index === 0 ? "builtin" : "custom" });
      } catch { /* an unreadable file is skipped; the others still load */ }
    }
  }
  return [...byId.values()];
}

// Trigger words match at a word start so Turkish suffixes still hit ("giriş" → "girişe", "sepet" → "sepetime").
function hits(skill, text) {
  return skill.triggers.filter((trigger) => text.includes(` ${trigger}`)).length;
}

// `texts[0]` is the tester's sentence; the rest are recent turns, which count less.
export function selectSkills(skills, texts, budget = SKILL_BUDGET) {
  const [current = "", ...earlier] = texts;
  const now = ` ${fold(current)} `;
  const before = ` ${earlier.map(fold).join(" ")} `;
  const ranked = skills
    .map((skill) => ({ skill, score: skill.always ? Infinity : hits(skill, now) * 2 + hits(skill, before) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const chosen = [];
  let used = 0;
  for (const { skill } of ranked) {
    if (!skill.always && used + skill.body.length > budget) continue;
    chosen.push(skill);
    used += skill.body.length;
  }
  return chosen;
}

export function skillPrompt(skills) {
  if (!skills.length) return "";
  return [
    "# QA skills",
    "The skills below are your professional know-how for this request. Follow them when designing cases and writing steps; the output rules above still win.",
    ...skills.map((skill) => `\n<skill name="${skill.name}">\n${skill.body}\n</skill>`),
  ].join("\n");
}

export const MIDSCENE_CONTEXT_LIMIT = 2_000;

// A skill's "## Midscene" section: short notes for the screen-driving agent itself, not for the planner.
export function midsceneNotes(skill) {
  const match = /^##[ \t]+Midscene\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/im.exec(skill.body || "");
  return match ? match[1].trim() : "";
}

// Midscene receives these as its agent-level AI context on every AI call of a case, so they stay short.
export function midsceneContext(skills, limit = MIDSCENE_CONTEXT_LIMIT) {
  const parts = [];
  let used = 0;
  for (const skill of skills) {
    const notes = midsceneNotes(skill);
    if (!notes || used + notes.length > limit) continue;
    parts.push(notes);
    used += notes.length;
  }
  return parts.length ? `Test ortamı notları (bir QA uzmanından):\n${parts.join("\n")}` : "";
}

// Skills for one saved YAML case: its title, tags and step texts play the role of the tester's sentence.
export function caseSkillText(item) {
  return [item.title, ...(item.tags || []), ...(item.steps || []).map((step) => step.text)].filter(Boolean).join(" ");
}
