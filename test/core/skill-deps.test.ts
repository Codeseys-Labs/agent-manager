import { describe, expect, test } from "bun:test";
import { parseSkillAgentRefs } from "../../src/core/skill-deps";

describe("parseSkillAgentRefs", () => {
  test("extracts a single Task(subagent_type='...') reference", () => {
    const body = "Then run Task(subagent_type='hyperresearch-fetcher', prompt='go').";
    expect(parseSkillAgentRefs(body)).toEqual(["hyperresearch-fetcher"]);
  });

  test("matches double-quoted values too", () => {
    const body = 'Spawn Task(subagent_type="code-reviewer").';
    expect(parseSkillAgentRefs(body)).toEqual(["code-reviewer"]);
  });

  test("matches a bare subagent_type reference without Task(", () => {
    const body = "The skill delegates to subagent_type: 'researcher' for deep dives.";
    expect(parseSkillAgentRefs(body)).toEqual(["researcher"]);
  });

  test("returns multiple distinct refs in first-seen order", () => {
    const body = [
      "Task(subagent_type='alpha')",
      'later Task(subagent_type="beta")',
      "finally subagent_type = 'gamma'",
    ].join("\n");
    expect(parseSkillAgentRefs(body)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("de-duplicates repeated references", () => {
    const body = [
      "Task(subagent_type='hyperresearch-fetcher')",
      "Task(subagent_type='hyperresearch-fetcher')",
      'Task(subagent_type="hyperresearch-fetcher")',
    ].join("\n");
    expect(parseSkillAgentRefs(body)).toEqual(["hyperresearch-fetcher"]);
  });

  test("returns empty array for a body with no Task refs", () => {
    const body = "# My Skill\n\nThis skill just reads files and prints a summary.";
    expect(parseSkillAgentRefs(body)).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    expect(parseSkillAgentRefs("")).toEqual([]);
  });
});
