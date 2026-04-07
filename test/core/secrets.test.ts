import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { interpolateEnv } from "../../src/core/secrets";
import type { Config } from "../../src/core/schema";

describe("interpolateEnv", () => {
  const origEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string) {
    origEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Clear for next test
    for (const key of Object.keys(origEnv)) {
      delete origEnv[key];
    }
  });

  test("resolves ${VAR} from process.env", () => {
    setEnv("AM_TEST_CMD", "my-mcp-server");

    const config: Config = {
      servers: {
        s: { command: "${AM_TEST_CMD}", transport: "stdio", enabled: true },
      },
    };
    const { config: result, warnings } = interpolateEnv(config);

    expect(result.servers?.s.command).toBe("my-mcp-server");
    expect(warnings).toHaveLength(0);
  });

  test("resolves in nested strings (args arrays)", () => {
    setEnv("AM_TEST_FLAG", "--verbose");

    const config: Config = {
      servers: {
        s: {
          command: "server",
          args: ["${AM_TEST_FLAG}", "--port", "8080"],
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const { config: result } = interpolateEnv(config);

    expect(result.servers?.s.args).toEqual(["--verbose", "--port", "8080"]);
  });

  test("escapes $${VAR} to literal ${VAR}", () => {
    const config: Config = {
      servers: {
        s: { command: "$${KEEP_THIS}", transport: "stdio", enabled: true },
      },
    };
    const { config: result, warnings } = interpolateEnv(config);

    expect(result.servers?.s.command).toBe("${KEEP_THIS}");
    expect(warnings).toHaveLength(0);
  });

  test("warns on unresolved variable (non-strict)", () => {
    // Ensure this var is NOT set
    delete process.env.AM_NONEXISTENT_VAR;

    const config: Config = {
      servers: {
        s: {
          command: "${AM_NONEXISTENT_VAR}",
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const { config: result, warnings } = interpolateEnv(config);

    expect(result.servers?.s.command).toBe("${AM_NONEXISTENT_VAR}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AM_NONEXISTENT_VAR");
  });

  test("throws on unresolved variable (strict mode)", () => {
    delete process.env.AM_NONEXISTENT_VAR;

    const config: Config = {
      servers: {
        s: {
          command: "${AM_NONEXISTENT_VAR}",
          transport: "stdio",
          enabled: true,
        },
      },
    };

    expect(() => interpolateEnv(config, { strict: true })).toThrow(
      "Unresolved variable: ${AM_NONEXISTENT_VAR}",
    );
  });

  test("resolves from extraEnv", () => {
    const config: Config = {
      servers: {
        s: {
          command: "${AM_EXTRA_VAR}",
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const { config: result, warnings } = interpolateEnv(config, {
      extraEnv: { AM_EXTRA_VAR: "extra-value" },
    });

    expect(result.servers?.s.command).toBe("extra-value");
    expect(warnings).toHaveLength(0);
  });

  test("process.env takes precedence over extraEnv", () => {
    setEnv("AM_PRECEDENCE_VAR", "from-env");

    const config: Config = {
      servers: {
        s: {
          command: "${AM_PRECEDENCE_VAR}",
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const { config: result } = interpolateEnv(config, {
      extraEnv: { AM_PRECEDENCE_VAR: "from-extra" },
    });

    expect(result.servers?.s.command).toBe("from-env");
  });

  test("handles multiple variables in one string", () => {
    setEnv("AM_HOST", "localhost");
    setEnv("AM_PORT", "8080");

    const config: Config = {
      servers: {
        s: {
          command: "http://${AM_HOST}:${AM_PORT}/api",
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const { config: result } = interpolateEnv(config);

    expect(result.servers?.s.command).toBe("http://localhost:8080/api");
  });

  test("interpolates strings in arrays (tags)", () => {
    setEnv("AM_TAG", "dynamic-tag");

    const config: Config = {
      servers: {
        s: {
          command: "server",
          transport: "stdio",
          enabled: true,
          tags: ["static", "${AM_TAG}"],
        },
      },
    };
    const { config: result } = interpolateEnv(config);

    expect(result.servers?.s.tags).toEqual(["static", "dynamic-tag"]);
  });

  test("interpolates env table values in servers", () => {
    setEnv("AM_AUTH_TOKEN", "secret123");

    const config: Config = {
      servers: {
        s: {
          command: "server",
          transport: "stdio",
          enabled: true,
          env: { AUTH: "${AM_AUTH_TOKEN}" },
        },
      },
    };
    const { config: result } = interpolateEnv(config);

    expect(result.servers?.s.env?.AUTH).toBe("secret123");
  });

  test("interpolates profile env values", () => {
    setEnv("AM_AWS_PROFILE", "my-profile");

    const config: Config = {
      profiles: {
        work: {
          env: { AWS_PROFILE: "${AM_AWS_PROFILE}" },
        },
      },
    };
    const { config: result } = interpolateEnv(config);

    expect(result.profiles?.work.env?.AWS_PROFILE).toBe("my-profile");
  });
});
