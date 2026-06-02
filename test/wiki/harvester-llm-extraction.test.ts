import { describe, expect, test } from "bun:test";
import type { Message, Session } from "../../src/core/session";
import { type LlmExtractor, harvestSession, noopLlmExtractor } from "../../src/wiki/harvester";
import type { KnowledgeEntry, KnowledgeSource } from "../../src/wiki/types";

// ADR-0054 R8 + ADR-0010: LLM extraction is OPT-IN, GATED, and degrades
// gracefully. agent-manager ships NO LLM client — the extractor is an injected
// interface with a no-op default. These tests prove the default-off path and
// the graceful-degradation contract without any embedded model.

function makeSession(messages: Message[]): Session {
  return { id: "llm-sess", adapter: "claude-code", messages, startedAt: new Date() };
}

const SESSION = makeSession([
  {
    role: "user",
    content: "The project is built with Bun and uses src/index.ts as the entry point.",
  },
  {
    role: "assistant",
    content: "Confirmed — Bun runs src/index.ts.",
  },
]);

function makeFakeEntry(content: string, source: KnowledgeSource): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    source,
    extracted_at: now,
    confidence: 0.9,
    entity_type: "fact",
    content,
    context: "",
    tags: ["llm-synthesized"],
    references: [],
    provenance: {
      created_by: "test-llm",
      created_at: now,
      last_modified: now,
      modification_history: [],
      verified: false,
    },
  };
}

describe("wiki/harvester gated LLM extraction (ADR-0054 R8 / ADR-0010)", () => {
  test("default (no opts): pattern-only, no LLM involvement", async () => {
    const baseline = await harvestSession(SESSION);
    // Same call with an explicit empty opts object — must be identical.
    const withEmptyOpts = await harvestSession(SESSION, {});
    expect(withEmptyOpts.length).toBe(baseline.length);
    // No entry is tagged as LLM-synthesized in the default path.
    expect(withEmptyOpts.some((e) => e.tags.includes("llm-synthesized"))).toBe(false);
  });

  test("llmExtraction:false is a no-op even if an extractor is provided", async () => {
    let called = false;
    const extractor: LlmExtractor = {
      extract({ source }) {
        called = true;
        return [makeFakeEntry("LLM fact", source)];
      },
    };
    const baseline = await harvestSession(SESSION);
    const result = await harvestSession(SESSION, { llmExtraction: false, llmExtractor: extractor });

    expect(called).toBe(false); // gate is closed
    expect(result.length).toBe(baseline.length);
    expect(result.some((e) => e.tags.includes("llm-synthesized"))).toBe(false);
  });

  test("llmExtraction:true with NO extractor degrades to the no-op default", async () => {
    const baseline = await harvestSession(SESSION);
    const result = await harvestSession(SESSION, { llmExtraction: true });
    // No extractor injected ⇒ noopLlmExtractor ⇒ zero extra entries.
    expect(result.length).toBe(baseline.length);
  });

  test("noopLlmExtractor returns no entries", async () => {
    const source: KnowledgeSource = {
      type: "session_harvest",
      timestamp: new Date().toISOString(),
    };
    const out = await noopLlmExtractor.extract({
      session: SESSION,
      source,
      heuristicEntries: [],
    });
    expect(out).toEqual([]);
  });

  test("llmExtraction:true WITH an extractor merges its entries (opt-in path)", async () => {
    const extractor: LlmExtractor = {
      extract({ session, source, heuristicEntries }) {
        // The extractor sees the session and the heuristic entries.
        expect(session.id).toBe("llm-sess");
        expect(Array.isArray(heuristicEntries)).toBe(true);
        return [makeFakeEntry("A distinct synthesized insight about deployment cadence", source)];
      },
    };
    const result = await harvestSession(SESSION, { llmExtraction: true, llmExtractor: extractor });
    expect(result.some((e) => e.tags.includes("llm-synthesized"))).toBe(true);
  });

  test("a throwing extractor degrades gracefully to heuristic entries", async () => {
    const explosive: LlmExtractor = {
      extract() {
        throw new Error("no LLM configured / network down");
      },
    };
    const baseline = await harvestSession(SESSION);
    const result = await harvestSession(SESSION, {
      llmExtraction: true,
      llmExtractor: explosive,
    });
    // The throw is swallowed; we keep exactly the heuristic entries.
    expect(result.length).toBe(baseline.length);
  });

  test("an async-rejecting extractor degrades gracefully", async () => {
    const rejecting: LlmExtractor = {
      async extract() {
        throw new Error("async failure");
      },
    };
    const baseline = await harvestSession(SESSION);
    const result = await harvestSession(SESSION, {
      llmExtraction: true,
      llmExtractor: rejecting,
    });
    expect(result.length).toBe(baseline.length);
  });

  test("a misbehaving extractor that mutates its input does not corrupt the harvest", async () => {
    // The contract says the extractor MUST NOT mutate the heuristic entries.
    // Prove the harvester is robust even against an extractor that ignores that
    // contract: this one casts away `readonly` and actively tries to (a) push a
    // junk entry, (b) clear the array, and (c) overwrite an entry's content.
    let mutatedContents: string[] = [];
    let lengthSeenByExtractor = 0;
    const vandal: LlmExtractor = {
      extract({ heuristicEntries }) {
        lengthSeenByExtractor = heuristicEntries.length;
        // Snapshot what the extractor was handed, BEFORE attempting to mutate.
        mutatedContents = heuristicEntries.map((e) => e.content);
        const writable = heuristicEntries as KnowledgeEntry[];
        if (writable.length > 0) {
          writable[0] = { ...writable[0], content: "VANDALIZED" };
        }
        writable.push(
          makeFakeEntry("injected junk that should not survive as heuristic", {
            type: "session_harvest",
            timestamp: new Date().toISOString(),
          }),
        );
        return [];
      },
    };

    const baseline = await harvestSession(SESSION);
    const result = await harvestSession(SESSION, { llmExtraction: true, llmExtractor: vandal });

    // The extractor genuinely received the heuristic entries (so the assertions
    // below are not vacuous).
    expect(lengthSeenByExtractor).toBeGreaterThan(0);

    // The vandal returned [] extra entries, so the result count must equal the
    // pattern-only baseline — its in-place push must NOT have leaked through.
    expect(result.length).toBe(baseline.length);

    // None of the surviving entries carries the vandalized marker or the
    // injected-junk content: the heuristic entries the harvester keeps match the
    // ORIGINAL heuristic contents the extractor was shown.
    const resultContents = result.map((e) => e.content).sort();
    expect(resultContents).toEqual([...mutatedContents].sort());
    expect(result.some((e) => e.content === "VANDALIZED")).toBe(false);
    expect(result.some((e) => e.content.includes("injected junk"))).toBe(false);
  });
});
