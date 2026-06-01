import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../src/core/schema";

// ADR-0046: schema rejects `[settings.secrets].team_passphrase` outright.
// Forces per-recipient X25519 identity workflow (per ADR-0042) instead of
// a shared team passphrase.

describe("ADR-0046: schema rejects team_passphrase", () => {
  test("config without team_passphrase is accepted", () => {
    const config = {
      settings: {
        secrets: {
          backend: "age",
        },
      },
    };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("config with team_passphrase is rejected with ADR-0046 message", () => {
    const config = {
      settings: {
        secrets: {
          backend: "age",
          team_passphrase: "would-be-shared-secret",
        },
      },
    };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    const errs = result.error.issues.map((i) => i.message).join("\n");
    expect(errs).toContain("ADR-0046");
    expect(errs).toContain("team_passphrase");
    // P0-3 §4: the message must point at the REAL command (`am pair accept`),
    // not the dead `am secrets add-recipient` that never existed.
    expect(errs).toContain("am pair accept");
    expect(errs).not.toContain("am secrets add-recipient");
  });

  test("error path points at team_passphrase", () => {
    const config = {
      settings: {
        secrets: {
          team_passphrase: "$ARGON2_HASH",
        },
      },
    };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    // The path should include team_passphrase so editors can highlight
    // the offending field, not the parent settings table.
    const paths = result.error.issues.map((i) => i.path);
    const includesField = paths.some((p) => p.includes("team_passphrase"));
    expect(includesField).toBe(true);
  });

  test("rejection survives unknown sibling fields (passthrough still works)", () => {
    const config = {
      settings: {
        secrets: {
          backend: "age",
          custom_extension_field: "something-the-future-needs",
        },
      },
    };
    // passthrough allows unknown fields; rejection only fires on team_passphrase
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("config with team_passphrase plus other valid fields still rejects", () => {
    const config = {
      settings: {
        secrets: {
          backend: "age",
          team_passphrase: "anything",
          // even with a valid backend, presence of team_passphrase is fatal
        },
      },
    };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
