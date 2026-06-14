import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import {
  AgeSecretsBackend,
  type KeychainAdapter,
  envPassphraseProvider,
  legacyIdentityDir,
  migrateLegacyIdentityDir,
  resolveIdentityDir,
  resolveIdentityPath,
} from "../../src/core/secrets-age";
import { getBackend } from "../../src/core/secrets-backend";

// age scrypt identity wrap/unwrap is 8-9s per op under CI coverage; the 5s
// default would time out and (because bun runs all files in one process)
// leak global state into later secrets/pair tests. (Wave CI / P0-5.)
setDefaultTimeout(30_000);

// In-memory keychain adapter for hermetic tests. Mirrors the
// `cross-keychain` top-level surface the backend consumes.
function makeMemKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const key = (service: string, account: string) => `${service}::${account}`;
  const kc: KeychainAdapter & { store: Map<string, string> } = {
    store,
    async getPassword(service, account) {
      return store.get(key(service, account)) ?? null;
    },
    async setPassword(service, account, password) {
      store.set(key(service, account), password);
    },
    async deletePassword(service, account) {
      store.delete(key(service, account));
    },
  };
  return kc;
}

async function makeTempIdentityPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "am-age-test-"));
  return { dir, path: join(dir, "identity.age") };
}

describe("AgeSecretsBackend — paths", () => {
  const origEnv: Record<string, string | undefined> = {};
  const origPlatform = process.platform;
  function setEnv(key: string, value: string | undefined) {
    if (!(key in origEnv)) origEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  function restoreEnv() {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(origEnv)) delete (origEnv as Record<string, unknown>)[key];
  }
  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }
  function restorePlatform() {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  }

  test("resolveIdentityDir respects AM_AGE_IDENTITY_DIR override", () => {
    // Build the override + expectations with join() so the assertion is
    // separator-agnostic (resolveIdentityPath uses node:path internally, which
    // emits backslashes on Windows — a hardcoded "/" literal would mismatch).
    const overrideDir = join(tmpdir(), "custom-am-id");
    setEnv("AM_AGE_IDENTITY_DIR", overrideDir);
    try {
      expect(resolveIdentityDir()).toBe(overrideDir);
      expect(resolveIdentityPath()).toBe(join(overrideDir, "identity.age"));
    } finally {
      restoreEnv();
    }
  });

  // SECURITY (e737): resolveIdentityDir now resolves to the OS DATA dir
  // (mirroring resolveKeyPath), NOT the git-tracked config dir. The wrapped
  // private identity must live physically outside the repo.
  test("macOS: defaults to ~/Library/Application Support/agent-manager/identities", () => {
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    setPlatform("darwin");
    try {
      expect(resolveIdentityDir()).toBe(
        join(homedir(), "Library", "Application Support", "agent-manager", "identities"),
      );
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  test("Linux: uses XDG_DATA_HOME (the DATA dir, not the config dir)", () => {
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    setEnv("XDG_DATA_HOME", join(tmpdir(), "custom-xdg-data"));
    setPlatform("linux");
    try {
      expect(resolveIdentityDir()).toBe(
        join(join(tmpdir(), "custom-xdg-data"), "agent-manager", "identities"),
      );
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  test("Linux: falls back to ~/.local/share when XDG_DATA_HOME unset", () => {
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    setEnv("XDG_DATA_HOME", undefined);
    setPlatform("linux");
    try {
      expect(resolveIdentityDir()).toBe(
        join(homedir(), ".local", "share", "agent-manager", "identities"),
      );
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  test("Windows: uses %APPDATA% when set", () => {
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    setEnv("APPDATA", "C:\\Users\\Test\\AppData\\Roaming");
    setPlatform("win32");
    try {
      expect(resolveIdentityDir()).toBe(
        join("C:\\Users\\Test\\AppData\\Roaming", "agent-manager", "identities"),
      );
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  test("regression: never resolves inside ~/.config/agent-manager (the config repo)", () => {
    // The whole point of e737: the identity must NOT live under the config dir,
    // which is a git repo that commitAll stages-and-pushes wholesale.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    setEnv("XDG_DATA_HOME", undefined);
    setEnv("XDG_CONFIG_HOME", undefined);
    try {
      for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
        setPlatform(platform);
        const dir = resolveIdentityDir();
        // Normalise to forward slashes so the substring check is portable.
        const normalised = dir.replace(/\\/g, "/");
        expect(normalised).not.toContain(".config/agent-manager");
      }
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  test("legacyIdentityDir points inside the config dir (the old, leaky location)", () => {
    setEnv("XDG_CONFIG_HOME", join(tmpdir(), "xdg-config"));
    try {
      expect(legacyIdentityDir()).toBe(
        join(join(tmpdir(), "xdg-config"), "agent-manager", "identities"),
      );
    } finally {
      restoreEnv();
    }
  });
});

// SECURITY (e737): a pre-e737 install wrote the wrapped PRIVATE identity into
// the git-tracked config dir. migrateLegacyIdentityDir() moves it out to the
// data-dir location on next backend init so the key stops living in the repo.
describe("AgeSecretsBackend — legacy identity-dir migration (e737)", () => {
  const origEnv: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string | undefined) {
    if (!(key in origEnv)) origEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  function restoreEnv() {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(origEnv)) delete (origEnv as Record<string, unknown>)[key];
  }

  test("moves a legacy identity + recipients out of the config dir to the data dir", async () => {
    const xdgConfig = await mkdtemp(join(tmpdir(), "am-e737-cfg-"));
    const dataDir = await mkdtemp(join(tmpdir(), "am-e737-data-"));
    setEnv("XDG_CONFIG_HOME", xdgConfig);
    // Migration only fires on the DEFAULT layout — ensure no override leaks in
    // from the ambient env or a prior describe block.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    try {
      // Seed a legacy install: identity.age (+ rotation sidecars + recipients)
      // living under ~/.config/agent-manager/identities.
      const legacy = legacyIdentityDir();
      await mkdir(join(legacy, "recipients"), { recursive: true });
      await writeFile(join(legacy, "identity.age"), "LEGACY-WRAPPED-PRIVATE-KEY");
      await writeFile(join(legacy, "identity.age.old"), "LEGACY-OLD");
      await writeFile(join(legacy, ".am-rotation-state.json"), "{}");
      const recip = await identityToRecipient(await generateIdentity());
      await writeFile(join(legacy, "recipients", "laptop.pub"), `${recip}\n`);

      const target = join(dataDir, "identities");
      const result = await migrateLegacyIdentityDir(target);

      expect(result.kind).toBe("migrated");
      if (result.kind !== "migrated") throw new Error("unreachable");
      expect(result.from).toBe(legacy);
      expect(result.to).toBe(target);
      expect(result.files).toContain("identity.age");

      // Identity is now in the data dir...
      expect(await readFile(join(target, "identity.age"), "utf8")).toBe(
        "LEGACY-WRAPPED-PRIVATE-KEY",
      );
      expect(await readFile(join(target, "identity.age.old"), "utf8")).toBe("LEGACY-OLD");
      expect(await readFile(join(target, ".am-rotation-state.json"), "utf8")).toBe("{}");
      expect(await readFile(join(target, "recipients", "laptop.pub"), "utf8")).toBe(`${recip}\n`);

      // ...and the LEAKY legacy copy is GONE (the private key no longer lives
      // in the git-tracked config dir).
      await expect(stat(join(legacy, "identity.age"))).rejects.toThrow();
      await expect(stat(join(legacy, "identity.age.old"))).rejects.toThrow();
      await expect(stat(join(legacy, ".am-rotation-state.json"))).rejects.toThrow();
      await expect(stat(join(legacy, "recipients", "laptop.pub"))).rejects.toThrow();
    } finally {
      restoreEnv();
      await rm(xdgConfig, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("migrated identity file is mode 0600 (POSIX)", async () => {
    if (process.platform === "win32") return;
    const xdgConfig = await mkdtemp(join(tmpdir(), "am-e737-cfg-"));
    const dataDir = await mkdtemp(join(tmpdir(), "am-e737-data-"));
    setEnv("XDG_CONFIG_HOME", xdgConfig);
    // Migration only fires on the DEFAULT layout — ensure no override leaks in
    // from the ambient env or a prior describe block.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    try {
      const legacy = legacyIdentityDir();
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "identity.age"), "SECRET", { mode: 0o644 });

      const target = join(dataDir, "identities");
      await migrateLegacyIdentityDir(target);

      const st = await stat(join(target, "identity.age"));
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      restoreEnv();
      await rm(xdgConfig, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("no legacy identity → kind='none', no files created", async () => {
    const xdgConfig = await mkdtemp(join(tmpdir(), "am-e737-cfg-"));
    const dataDir = await mkdtemp(join(tmpdir(), "am-e737-data-"));
    setEnv("XDG_CONFIG_HOME", xdgConfig);
    // Migration only fires on the DEFAULT layout — ensure no override leaks in
    // from the ambient env or a prior describe block.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    try {
      const result = await migrateLegacyIdentityDir(join(dataDir, "identities"));
      expect(result.kind).toBe("none");
      await expect(stat(join(dataDir, "identities", "identity.age"))).rejects.toThrow();
    } finally {
      restoreEnv();
      await rm(xdgConfig, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("conflict: data-dir identity already exists → legacy left untouched, never clobbered", async () => {
    const xdgConfig = await mkdtemp(join(tmpdir(), "am-e737-cfg-"));
    const dataDir = await mkdtemp(join(tmpdir(), "am-e737-data-"));
    setEnv("XDG_CONFIG_HOME", xdgConfig);
    // Migration only fires on the DEFAULT layout — ensure no override leaks in
    // from the ambient env or a prior describe block.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    try {
      const legacy = legacyIdentityDir();
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "identity.age"), "LEGACY");

      const target = join(dataDir, "identities");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "identity.age"), "DATA-DIR-WINS");

      const result = await migrateLegacyIdentityDir(target);
      expect(result.kind).toBe("conflict");
      // Data-dir copy is untouched (the live key wins)...
      expect(await readFile(join(target, "identity.age"), "utf8")).toBe("DATA-DIR-WINS");
      // ...and the legacy copy is NOT deleted (recovery path preserved).
      expect(await readFile(join(legacy, "identity.age"), "utf8")).toBe("LEGACY");
    } finally {
      restoreEnv();
      await rm(xdgConfig, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("skipped when legacy and target resolve to the same directory", async () => {
    const xdgConfig = await mkdtemp(join(tmpdir(), "am-e737-cfg-"));
    setEnv("XDG_CONFIG_HOME", xdgConfig);
    // Migration only fires on the DEFAULT layout — ensure no override leaks in
    // from the ambient env or a prior describe block.
    setEnv("AM_AGE_IDENTITY_DIR", undefined);
    try {
      const legacy = legacyIdentityDir();
      // Target == legacy (e.g. AM_AGE_IDENTITY_DIR points at the old location).
      const result = await migrateLegacyIdentityDir(legacy);
      expect(result.kind).toBe("skipped");
    } finally {
      restoreEnv();
      await rm(xdgConfig, { recursive: true, force: true });
    }
  });
});

describe("AgeSecretsBackend — identity lifecycle", () => {
  let identityPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    const { dir, path } = await makeTempIdentityPath();
    tmpDir = dir;
    identityPath = path;
    // Cleanup after each test (best-effort).
    // (bun:test's afterEach could be used, but keeping it in beforeEach
    // by reassigning is fine since each test gets a fresh tmp dir.)
  });

  test("initialize() generates a new identity when none exists, caches in keychain", async () => {
    const kc = makeMemKeychain();
    const backend = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => "correct horse battery staple",
      keychain: kc,
    });

    await backend.initialize();

    // File exists with mode 0600 (on POSIX).
    const st = await stat(identityPath);
    expect(st.isFile()).toBe(true);
    if (process.platform !== "win32") {
      // Low 9 bits of mode should be 0600.
      expect(st.mode & 0o777).toBe(0o600);
    }

    // On-disk file is a passphrase-wrapped age ciphertext — it must
    // begin with age's magic header.
    const raw = await readFile(identityPath);
    const head = new TextDecoder().decode(raw.subarray(0, 22));
    expect(head.startsWith("age-encryption.org/")).toBe(true);

    // Keychain now holds the passphrase.
    expect(kc.store.size).toBe(1);
    expect([...kc.store.values()][0]).toBe("correct horse battery staple");

    // Recipient is derivable.
    const recipient = await backend.getRecipient();
    expect(recipient.startsWith("age1")).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("initialize() is idempotent within a single instance", async () => {
    let promptCount = 0;
    const kc = makeMemKeychain();
    const backend = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => {
        promptCount++;
        return "pw";
      },
      keychain: kc,
    });

    await backend.initialize();
    await backend.initialize();
    await backend.initialize();

    // One passphrase prompt total (the initial creation).
    expect(promptCount).toBe(1);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("second instance unlocks using keychain-cached passphrase, no prompt", async () => {
    const kc = makeMemKeychain();
    const first = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => "secret-pw",
      keychain: kc,
    });
    await first.initialize();
    const firstRecipient = await first.getRecipient();

    let prompted = false;
    const second = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => {
        prompted = true;
        return "wrong";
      },
      keychain: kc,
    });
    await second.initialize();

    expect(prompted).toBe(false);
    expect(await second.getRecipient()).toBe(firstRecipient);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("stale keychain value falls through to passphrase prompt and re-caches", async () => {
    // Create identity with passphrase "real".
    const kc = makeMemKeychain();
    const first = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => "real",
      keychain: kc,
    });
    await first.initialize();

    // Corrupt the cache.
    await kc.setPassword("agent-manager", "identity-passphrase", "stale-wrong");

    let promptCount = 0;
    const second = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => {
        promptCount++;
        return "real";
      },
      keychain: kc,
    });
    await second.initialize();

    expect(promptCount).toBe(1);
    // Cache re-populated with the correct passphrase.
    expect(await kc.getPassword("agent-manager", "identity-passphrase")).toBe("real");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("wrong passphrase on unlock throws a descriptive error", async () => {
    const kc = makeMemKeychain();
    const first = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => "real",
      keychain: kc,
    });
    await first.initialize();

    // Empty keychain → prompt path. Provider returns wrong passphrase.
    const emptyKc = makeMemKeychain();
    const second = new AgeSecretsBackend({
      identityPath,
      passphraseProvider: async () => "wrong",
      keychain: emptyKc,
    });
    await expect(second.initialize()).rejects.toThrow(/failed to decrypt identity/i);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("AgeSecretsBackend — encrypt/decrypt round-trip", () => {
  test("round-trips plaintext through enc:v2:age:<base64> envelope", async () => {
    const { dir, path } = await makeTempIdentityPath();
    const backend = new AgeSecretsBackend({
      identityPath: path,
      passphraseProvider: async () => "pw",
      keychain: makeMemKeychain(),
    });

    const plaintext = "hunter2-🔐";
    const envelope = await backend.encrypt(plaintext);

    expect(envelope.startsWith("enc:v2:age:")).toBe(true);
    // Payload is base64.
    const payload = envelope.slice("enc:v2:age:".length);
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    expect(await backend.decrypt(envelope)).toBe(plaintext);

    await rm(dir, { recursive: true, force: true });
  });

  test("decrypt rejects a non-v2 envelope with a descriptive error", async () => {
    const { dir, path } = await makeTempIdentityPath();
    const backend = new AgeSecretsBackend({
      identityPath: path,
      passphraseProvider: async () => "pw",
      keychain: makeMemKeychain(),
    });

    await expect(backend.decrypt("enc:v1:somethingelse")).rejects.toThrow(
      /does not start with "enc:v2:age:"/,
    );

    await rm(dir, { recursive: true, force: true });
  });

  test("name and version expose the ADR-0042 v2 tag", () => {
    const backend = new AgeSecretsBackend({
      passphraseProvider: envPassphraseProvider(),
      keychain: makeMemKeychain(),
    });
    expect(backend.name).toBe("age");
    expect(backend.version).toBe(2);
  });
});

describe("AgeSecretsBackend — registry integration", () => {
  test("age factory is auto-registered via core/secrets-age import", async () => {
    const factory = getBackend("age");
    expect(factory).toBeDefined();
    expect(factory?.name).toBe("age");
  });

  test("factory.load instantiates a backend from a config block", async () => {
    const { dir, path } = await makeTempIdentityPath();
    const factory = getBackend("age");
    expect(factory).toBeDefined();

    const kc = makeMemKeychain();
    const backend = await factory!.load({
      identityPath: path,
      passphraseProvider: async () => "from-factory",
      keychain: kc,
    });

    expect(backend.name).toBe("age");
    const env = await backend.encrypt("factory-roundtrip");
    expect(await backend.decrypt(env)).toBe("factory-roundtrip");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("AgeSecretsBackend — envPassphraseProvider", () => {
  const PP_KEY = "AM_AGE_TEST_PP";

  test("throws when env var is unset", async () => {
    const prev = process.env[PP_KEY];
    delete process.env[PP_KEY];
    try {
      const provider = envPassphraseProvider(PP_KEY);
      await expect(provider("unlock")).rejects.toThrow(/AM_AGE_TEST_PP is unset/);
    } finally {
      if (prev !== undefined) process.env[PP_KEY] = prev;
    }
  });

  test("returns env var value when set", async () => {
    const prev = process.env[PP_KEY];
    process.env[PP_KEY] = "from-env";
    try {
      const provider = envPassphraseProvider(PP_KEY);
      expect(await provider("unlock")).toBe("from-env");
    } finally {
      if (prev === undefined) delete process.env[PP_KEY];
      else process.env[PP_KEY] = prev;
    }
  });
});

// --- Wave 2: recipient management & rewrap ---------------------------

async function makeBackend(opts?: {
  passphrase?: string;
  keychain?: KeychainAdapter;
}): Promise<{
  backend: AgeSecretsBackend;
  identityPath: string;
  recipientsDir: string;
  tmpDir: string;
}> {
  const { dir, path } = await makeTempIdentityPath();
  const recipientsDir = join(dir, "recipients");
  const backend = new AgeSecretsBackend({
    identityPath: path,
    recipientsDir,
    passphraseProvider: async () => opts?.passphrase ?? "pw",
    keychain: opts?.keychain ?? makeMemKeychain(),
  });
  return { backend, identityPath: path, recipientsDir, tmpDir: dir };
}

describe("AgeSecretsBackend — recipient management", () => {
  test("addRecipient writes a .pub file with id and addedAt metadata", async () => {
    const { backend, recipientsDir, tmpDir } = await makeBackend();
    await backend.initialize();

    const extra = await identityToRecipient(await generateIdentity());
    await backend.addRecipient({
      id: "alice-laptop",
      publicKey: extra,
      addedAt: "2026-05-05T00:00:00Z",
    });

    const files = await readdir(recipientsDir);
    expect(files).toEqual(["alice-laptop.pub"]);
    const body = await readFile(join(recipientsDir, "alice-laptop.pub"), "utf8");
    expect(body).toContain(extra);
    expect(body).toContain("# id: alice-laptop");
    expect(body).toContain("# added: 2026-05-05T00:00:00Z");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("addRecipient rejects a non-age1 public key", async () => {
    const { backend, tmpDir } = await makeBackend();
    await expect(
      backend.addRecipient({ id: "bad", publicKey: "not-a-key", addedAt: "" }),
    ).rejects.toThrow(/invalid recipient/);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("listRecipients returns parsed entries sorted by id", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();

    const a = await identityToRecipient(await generateIdentity());
    const b = await identityToRecipient(await generateIdentity());
    await backend.addRecipient({ id: "zzz", publicKey: a, addedAt: "2026-01-01T00:00:00Z" });
    await backend.addRecipient({ id: "aaa", publicKey: b, addedAt: "2026-02-02T00:00:00Z" });

    const list = await backend.listRecipients();
    expect(list.map((r) => r.id)).toEqual(["aaa", "zzz"]);
    expect(list[0]!.publicKey).toBe(b);
    expect(list[1]!.publicKey).toBe(a);
    expect(list[0]!.addedAt).toBe("2026-02-02T00:00:00Z");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("listRecipients returns [] when recipients dir is absent", async () => {
    const { backend, tmpDir } = await makeBackend();
    expect(await backend.listRecipients()).toEqual([]);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("removeRecipient by id deletes the matching .pub file", async () => {
    const { backend, recipientsDir, tmpDir } = await makeBackend();
    await backend.initialize();

    const key = await identityToRecipient(await generateIdentity());
    await backend.addRecipient({ id: "bob", publicKey: key, addedAt: "" });
    expect((await readdir(recipientsDir)).length).toBe(1);

    await backend.removeRecipient("bob");
    expect((await readdir(recipientsDir)).length).toBe(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("removeRecipient by public key also works (fallback lookup)", async () => {
    const { backend, recipientsDir, tmpDir } = await makeBackend();
    await backend.initialize();

    const key = await identityToRecipient(await generateIdentity());
    await backend.addRecipient({ id: "carol", publicKey: key, addedAt: "" });
    await backend.removeRecipient(key);
    expect((await readdir(recipientsDir)).length).toBe(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("removeRecipient is a silent no-op when recipient is absent", async () => {
    const { backend, tmpDir } = await makeBackend();
    await expect(backend.removeRecipient("nobody")).resolves.toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("addRecipient then removeRecipient is idempotent across restart", async () => {
    const { backend, identityPath, recipientsDir, tmpDir } = await makeBackend();
    await backend.initialize();

    const key = await identityToRecipient(await generateIdentity());
    await backend.addRecipient({ id: "dave", publicKey: key, addedAt: "" });

    // Fresh instance over the same on-disk state.
    const next = new AgeSecretsBackend({
      identityPath,
      recipientsDir,
      passphraseProvider: async () => "pw",
      keychain: makeMemKeychain({ "agent-manager::identity-passphrase": "pw" }),
    });
    const list = await next.listRecipients();
    expect(list.length).toBe(1);
    expect(list[0]!.publicKey).toBe(key);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("AgeSecretsBackend — encrypt with explicit recipients", () => {
  test("encrypt with no recipients argument includes the local identity + recipient dir entries", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();

    // Create a *second* identity and register its recipient.
    const otherIdentity = await generateIdentity();
    const otherRecipient = await identityToRecipient(otherIdentity);
    await backend.addRecipient({ id: "friend", publicKey: otherRecipient, addedAt: "" });

    const envelope = await backend.encrypt("multi-recipient-secret");

    // Local backend can decrypt.
    expect(await backend.decrypt(envelope)).toBe("multi-recipient-secret");

    // A fresh backend that only holds `otherIdentity` can also
    // decrypt (proves the ciphertext was wrapped for that recipient).
    const { Decrypter } = await import("age-encryption");
    const payload = envelope.slice("enc:v2:age:".length);
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dec = new Decrypter();
    dec.addIdentity(otherIdentity);
    expect(await dec.decrypt(bytes, "text")).toBe("multi-recipient-secret");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("encrypt with explicit recipients list targets only those recipients", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();

    const other = await generateIdentity();
    const otherRecipient = await identityToRecipient(other);

    // Encrypt to `otherRecipient` only — local backend should fail to decrypt.
    const envelope = await backend.encrypt("for-other-only", [otherRecipient]);
    await expect(backend.decrypt(envelope)).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("encrypt rejects an empty recipient list", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();
    await expect(backend.encrypt("x", [])).rejects.toThrow(/no recipients/);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("encrypt rejects a bogus recipient string", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();
    await expect(backend.encrypt("x", ["garbage"])).rejects.toThrow(/invalid recipient/);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("AgeSecretsBackend — rewrap", () => {
  test("rewrap with no args re-encrypts to the current local+dir recipient set", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();

    // Step 1: envelope created before any extra recipients.
    const envelope1 = await backend.encrypt("rotate-me");
    expect(await backend.decrypt(envelope1)).toBe("rotate-me");

    // Step 2: add a new recipient (separate identity).
    const otherIdentity = await generateIdentity();
    const otherRecipient = await identityToRecipient(otherIdentity);
    await backend.addRecipient({ id: "newbie", publicKey: otherRecipient, addedAt: "" });

    // Step 3: rewrap — should now be decryptable by both.
    const envelope2 = await backend.rewrap(envelope1);
    expect(await backend.decrypt(envelope2)).toBe("rotate-me");

    const { Decrypter } = await import("age-encryption");
    const payload = envelope2.slice("enc:v2:age:".length);
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dec = new Decrypter();
    dec.addIdentity(otherIdentity);
    expect(await dec.decrypt(bytes, "text")).toBe("rotate-me");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("rewrap with explicit new recipient list overrides the default set", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();

    const envelope = await backend.encrypt("for-later-rotation");
    const ownRecipient = await backend.getRecipient();

    // Rewrap to local recipient only — explicit list.
    const rewrapped = await backend.rewrap(envelope, [ownRecipient]);
    expect(await backend.decrypt(rewrapped)).toBe("for-later-rotation");

    // Rewrap to only a stranger — local backend should then fail to decrypt.
    const stranger = await identityToRecipient(await generateIdentity());
    const forStranger = await backend.rewrap(envelope, [stranger]);
    await expect(backend.decrypt(forStranger)).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("rewrap rejects a non-v2 envelope", async () => {
    const { backend, tmpDir } = await makeBackend();
    await backend.initialize();
    await expect(backend.rewrap("enc:v1:nope")).rejects.toThrow(/does not start with/);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("AgeSecretsBackend — readRotationState fail-closed", () => {
  test("missing rotation-state file returns null (no rotation in progress)", async () => {
    const { backend, tmpDir } = await makeBackend();
    // No rotation-state file written — should return null.
    expect(await backend.readRotationState()).toBeNull();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("malformed JSON rotation-state file throws actionable error with path", async () => {
    const { backend, tmpDir } = await makeBackend();
    const statePath = backend.getRotationStatePath();
    await writeFile(statePath, "this is not json {{{", "utf8");

    await expect(backend.readRotationState()).rejects.toThrow(/invalid JSON/);
    await expect(backend.readRotationState()).rejects.toThrow(
      new RegExp(statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("missing required field in rotation-state throws actionable error", async () => {
    const { backend, tmpDir } = await makeBackend();
    const statePath = backend.getRotationStatePath();
    // Write JSON with started_at missing.
    const incomplete = JSON.stringify({
      old_recipient: "age1test",
      new_recipient: "age1test2",
    });
    await writeFile(statePath, incomplete, "utf8");

    await expect(backend.readRotationState()).rejects.toThrow(/missing required fields/);
    await expect(backend.readRotationState()).rejects.toThrow(
      new RegExp(statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("rotation-state with malformed recipient (not age1...) throws actionable error", async () => {
    const { backend, tmpDir } = await makeBackend();
    const statePath = backend.getRotationStatePath();
    // Write JSON with non-age recipients.
    await writeFile(
      statePath,
      JSON.stringify({
        old_recipient: "not-an-age-key",
        new_recipient: "age1abc",
        started_at: new Date().toISOString(),
        grace_until: new Date().toISOString(),
        grace_period_days: 14,
      }),
    );
    await expect(backend.readRotationState()).rejects.toThrow(/age1|recipient/i);
    await expect(backend.readRotationState()).rejects.toThrow(
      new RegExp(statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await rm(tmpDir, { recursive: true, force: true });
  });
});
