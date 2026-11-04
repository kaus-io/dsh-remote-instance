// src/http.ts
var OBSERVE_PATH = "/remote-instance/observe";
var ACTION_PATH = "/remote-instance/action";
var UI_READ_ACTIONS = /* @__PURE__ */ new Set(["instances"]);
var UI_ACTION_ACTIONS = /* @__PURE__ */ new Set(["add", "remove", "probe"]);
var BODY_LIMIT = 65536;
function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return void 0;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
  return void 0;
}
function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", aborted);
      signal?.removeEventListener("abort", cancelled);
    };
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else resolve(value ?? "");
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(new Error("Remote instance request is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks).toString("utf8"));
    const error = (failure) => finish(failure);
    const aborted = () => finish(new Error("Remote instance request was aborted"));
    const cancelled = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Remote instance request was cancelled"));
    req.on("data", data);
    req.on("end", end);
    req.on("error", error);
    req.on("aborted", aborted);
    req.once("close", () => req.off("error", error));
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}
function admitBrowser(service, req, res) {
  const connection = service.ctx.connection;
  if (!connection?.admit || !connection.browserPeer) {
    sendJson(res, 503, { ok: false, error: "Browser authentication is unavailable" });
    return false;
  }
  const admission = connection.admit(req);
  if (admission.rejection) {
    sendJson(res, admission.rejection.status ?? 403, { ok: false, error: "Browser authentication required" });
    return false;
  }
  if (admission.peer?.id !== connection.browserPeer.id) {
    sendJson(res, 403, { ok: false, error: "This endpoint requires the authenticated browser" });
    return false;
  }
  return true;
}
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function sameLoopbackOrigin(origin, expected) {
  if (!origin) return true;
  try {
    const actual = new URL(origin);
    const target = new URL(expected);
    if (actual.protocol !== target.protocol) return false;
    if (actual.port !== target.port) return false;
    return LOOPBACK_HOSTS.has(actual.hostname) && LOOPBACK_HOSTS.has(target.hostname);
  } catch {
    return false;
  }
}
function envelope(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error("Invalid remote instance JSON");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid remote instance request");
  const args = request.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("The request needs an args object");
  return args;
}
function createObserveHandler(service, originOf) {
  return async function observe(req, res) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client closed the remote instance observation"));
    });
    try {
      if (req.method !== "POST") throw new Error("Remote instance observation requires POST");
      if (!admitBrowser(service, req, res)) return void 0;
      if (req.headers["x-ri-observe"] !== "1") throw new Error("Missing remote instance observation header");
      const origin = originOf();
      if (origin && !sameLoopbackOrigin(req.headers.origin, origin)) throw new Error("Foreign origin");
      const args = envelope(await readBody(req, BODY_LIMIT, controller.signal));
      if (!UI_READ_ACTIONS.has(String(args.action))) throw new Error("This remote instance observation is not read-only");
      const value = await service.execute(args, { source: "ui", signal: controller.signal });
      return sendJson(res, 200, { ok: true, value });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return void 0;
      return sendJson(res, 400, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4e3) });
    }
  };
}
function createActionHandler(service, originOf) {
  return async function action(req, res) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client closed the remote instance action"));
    });
    try {
      if (req.method !== "POST") throw new Error("Remote instance action requires POST");
      if (!admitBrowser(service, req, res)) return void 0;
      if (req.headers["x-ri-action"] !== "1") throw new Error("Missing remote instance action header");
      if ((req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("Remote instance action requires JSON");
      if (!req.headers.origin) throw new Error("Missing remote instance action origin");
      const origin = originOf();
      if (origin && !sameLoopbackOrigin(req.headers.origin, origin)) throw new Error("Foreign origin");
      const args = envelope(await readBody(req, BODY_LIMIT, controller.signal));
      if (!UI_ACTION_ACTIONS.has(String(args.action))) throw new Error("This action is not available from the Settings panel");
      const value = await service.execute(args, { source: "ui", signal: controller.signal });
      return sendJson(res, 200, { ok: true, value });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return void 0;
      return sendJson(res, 400, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4e3) });
    }
  };
}

// src/settings.ts
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

// src/instances.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
var PLAIN_TEXT = /[\u0000-\u001f\u007f]/;
var HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
var USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
var JUMP_PATTERN = /^[A-Za-z0-9._:@-]{1,512}$/;
var PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var EXECUTABLE_PATTERN = /^[A-Za-z0-9._~/-]{1,1024}$/;
var ABSOLUTE_REMOTE = /^(?:\/|~\/)/;
var MAX_NOTE = 500;
function assertString(value, field, pattern, hint) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length > 1024 || PLAIN_TEXT.test(text)) throw new Error(`${field} contains characters that are not allowed`);
  if (!pattern.test(text)) throw new Error(`${field} is invalid: ${hint}`);
  return text;
}
function optionalString(value, field, pattern, hint) {
  if (value === void 0 || value === null || value === "") return void 0;
  return assertString(value, field, pattern, hint);
}
function displayTarget(instance) {
  return `${instance.user ? `${instance.user}@` : ""}${instance.host}${instance.port ? `:${instance.port}` : ""}`;
}
function validateInstance(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("An instance must be an object");
  const source = input;
  const now = options.now ?? Date.now();
  const name2 = assertString(source.name, "name", NAME_PATTERN, "start with a lowercase letter and use a-z, 0-9, - or _ (max 32)");
  const host = assertString(source.host, "host", HOST_PATTERN, "use a hostname, IP address, or ssh config alias");
  const port = source.port === void 0 || source.port === null ? void 0 : source.port;
  if (port !== void 0 && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error("port must be an integer in [1, 65535]");
  const identityFile = optionalString(source.identityFile, "identityFile", EXECUTABLE_PATTERN, "use an absolute path without spaces");
  if (identityFile !== void 0 && !identityFile.startsWith("/") && !identityFile.startsWith("~/")) throw new Error("identityFile must be an absolute path or start with ~/");
  const dsh = source.dsh === void 0 || source.dsh === null || source.dsh === "" ? "dsh" : assertString(source.dsh, "dsh", EXECUTABLE_PATTERN, "use a bare name or an absolute path");
  if (dsh.startsWith("-")) throw new Error("dsh must not start with -");
  const shell = source.shell === void 0 || source.shell === null ? "bash" : String(source.shell).trim();
  if (shell !== "" && !EXECUTABLE_PATTERN.test(shell)) throw new Error("shell must be a shell name such as bash, or an empty string to disable the wrapper");
  if (shell.startsWith("-")) throw new Error("shell must not start with -");
  const profile = source.profile === void 0 || source.profile === null || source.profile === "" ? "headless" : assertString(source.profile, "profile", PROFILE_PATTERN, "use a lowercase dsh profile name such as headless or sdk");
  const proxyJump = optionalString(source.proxyJump, "proxyJump", JUMP_PATTERN, "use [user@]host[:port]");
  const cwd = optionalString(source.cwd, "cwd", ABSOLUTE_REMOTE, "use an absolute path or a ~/ path");
  let note;
  if (source.note !== void 0 && source.note !== null && source.note !== "") {
    if (typeof source.note !== "string" || source.note.length > MAX_NOTE || PLAIN_TEXT.test(source.note)) throw new Error("note must be a short string without control characters");
    note = source.note.trim();
  }
  const instance = {
    name: name2,
    host,
    ...source.user === void 0 || source.user === null || source.user === "" ? {} : { user: assertString(source.user, "user", USER_PATTERN, "use a login name such as alice") },
    ...port === void 0 ? {} : { port },
    ...identityFile === void 0 ? {} : { identityFile },
    ...proxyJump === void 0 ? {} : { proxyJump },
    profile,
    dsh,
    shell,
    ...cwd === void 0 ? {} : { cwd },
    ...note === void 0 ? {} : { note },
    createdAt: options.existing?.createdAt ?? now,
    updatedAt: now,
    ...options.existing?.lastProbe === void 0 ? {} : { lastProbe: options.existing.lastProbe }
  };
  return instance;
}
function instanceSummary(instance) {
  return {
    name: instance.name,
    target: displayTarget(instance),
    host: instance.host,
    ...instance.user === void 0 ? {} : { user: instance.user },
    ...instance.port === void 0 ? {} : { port: instance.port },
    ...instance.identityFile === void 0 ? {} : { identityFile: instance.identityFile },
    ...instance.proxyJump === void 0 ? {} : { proxyJump: instance.proxyJump },
    profile: instance.profile,
    dsh: instance.dsh,
    shell: instance.shell,
    ...instance.cwd === void 0 ? {} : { cwd: instance.cwd },
    ...instance.note === void 0 ? {} : { note: instance.note },
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    ...instance.lastProbe === void 0 ? {} : { lastProbe: instance.lastProbe }
  };
}
function restoreInstance(input, options = {}) {
  const now = options.now ?? Date.now();
  const instance = validateInstance(input, { now });
  const source = input;
  const createdAt = Number.isSafeInteger(source.createdAt) ? source.createdAt : now;
  const updatedAt = Number.isSafeInteger(source.updatedAt) ? source.updatedAt : createdAt;
  const lastProbe = readProbe(source.lastProbe);
  return {
    ...instance,
    createdAt,
    updatedAt,
    ...lastProbe === void 0 ? {} : { lastProbe }
  };
}
function readProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const source = value;
  if (typeof source.ok !== "boolean" || !Number.isSafeInteger(source.at)) return void 0;
  const text = (candidate) => {
    if (typeof candidate !== "string" || !candidate || PLAIN_TEXT.test(candidate)) return void 0;
    return candidate.slice(0, 500);
  };
  return {
    at: source.at,
    ok: source.ok,
    ...text(source.version) === void 0 ? {} : { version: text(source.version) },
    ...text(source.os) === void 0 ? {} : { os: text(source.os) },
    ...text(source.message) === void 0 ? {} : { message: text(source.message) }
  };
}
var InstanceStore = class {
  file;
  now;
  chain = Promise.resolve();
  constructor(options) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
  }
  /** 清单文件路径。 / The list file path. */
  get path() {
    return this.file;
  }
  /** 读取清单；文件缺失视为空清单，损坏则抛错而不是静默清空。 / Read the list; a missing file is empty, a broken one throws. */
  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { instances: /* @__PURE__ */ new Map(), exists: false, skipped: [] };
      throw new Error(`Cannot read the remote instance list: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The remote instance list is not valid JSON; fix or delete it before retrying");
    }
    const rows = parsed && typeof parsed === "object" && Array.isArray(parsed.instances) ? parsed.instances : void 0;
    if (!rows) throw new Error("The remote instance list has no `instances` array");
    const instances = /* @__PURE__ */ new Map();
    const skipped = [];
    for (const row of rows) {
      try {
        const instance = restoreInstance(row, { now: this.now() });
        instances.set(instance.name, instance);
      } catch (error) {
        const name2 = row && typeof row === "object" && typeof row.name === "string" ? row.name.slice(0, 64) : "unknown";
        skipped.push(`${name2}: ${error.message}`);
      }
    }
    return { instances, exists: true, skipped };
  }
  /** 原子写回整份清单。 / Atomically write the whole list back. */
  async save(instances) {
    await this.serialize(() => this.writeNow(instances));
  }
  /** 串行执行一次读改写；写入不会再次排队，避免自锁。 / Run one read-modify-write; the write does not requeue. */
  async update(mutate) {
    return this.serialize(async () => {
      const snapshot = await this.load();
      const before = JSON.stringify([...snapshot.instances.values()]);
      await mutate(snapshot.instances);
      const after = JSON.stringify([...snapshot.instances.values()]);
      const changed = before !== after;
      if (changed) await this.writeNow(snapshot.instances);
      return { ...snapshot, changed };
    });
  }
  async writeNow(instances) {
    const body = JSON.stringify({ version: 1, instances: [...instances.values()] }, null, 2) + "\n";
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 384 });
    await rename(temporary, this.file);
  }
  serialize(operation) {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => void 0);
    return next;
  }
};

// src/settings.ts
var LIMITS = {
  connectTimeoutMs: [1e3, 12e4, 1e4],
  probeTimeoutMs: [1e3, 3e5, 3e4],
  taskTimeoutMs: [1e4, 864e5, 36e5],
  maxOutputBytes: [4096, 4194304, 262144]
};
var KNOWN_KEYS = /* @__PURE__ */ new Set(["storeFile", ...Object.keys(LIMITS), "instances"]);
function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}
function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return normalize(configured ? expandHome(configured) : join(homedir(), ".dsh"));
}
function displayPath(value) {
  const home = homedir();
  if (value.startsWith(home + sep)) return `~${value.slice(home.length)}`;
  const configured = process.env.DSH_HOME?.trim();
  if (configured) {
    const root = normalize(expandHome(configured));
    if (value.startsWith(root + sep)) return `$DSH_HOME${value.slice(root.length)}`;
  }
  return value;
}
function readInteger(source, key) {
  const value = source[key];
  if (value === void 0) return LIMITS[key][2];
  const [minimum, maximum] = LIMITS[key];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`remote-instance config: ${key} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}
function readStoreFile(source) {
  const value = source.storeFile;
  if (value === void 0) return join(resolveDshHome(), "remote-instances.json");
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("remote-instance config: storeFile must be a non-empty path without control characters");
  }
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) throw new Error("remote-instance config: storeFile must be absolute or start with ~");
  return normalize(expanded);
}
function resolveSettings(config) {
  if (config !== void 0 && config !== null && (typeof config !== "object" || Array.isArray(config))) {
    throw new Error("remote-instance config must be an object");
  }
  const source = config ?? {};
  for (const key of Object.keys(source)) if (!KNOWN_KEYS.has(key)) throw new Error(`remote-instance config: unknown field ${key}`);
  const seed = source.instances;
  if (seed !== void 0) {
    if (!Array.isArray(seed)) throw new Error("remote-instance config: instances must be a list");
    if (seed.length > 64) throw new Error("remote-instance config: instances accepts at most 64 entries");
    for (const entry of seed) validateInstance(entry, { now: 0 });
  }
  return {
    storeFile: readStoreFile(source),
    connectTimeoutMs: readInteger(source, "connectTimeoutMs"),
    probeTimeoutMs: readInteger(source, "probeTimeoutMs"),
    taskTimeoutMs: readInteger(source, "taskTimeoutMs"),
    maxOutputBytes: readInteger(source, "maxOutputBytes"),
    seed: seed === void 0 ? [] : seed
  };
}

// src/headless.ts
var MAX_ANSWER = 2e5;
var MAX_RAW = 1e6;
function brief(value, limit = 160) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = (text ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text;
}
function createTaskParser() {
  let buffer = "";
  let sawJson = false;
  let raw = "";
  let finalText;
  let sessionId;
  let toolCalls = 0;
  let errorText;
  const texts = [];
  const handleEvent = (event) => {
    switch (event.type) {
      case "session": {
        if (typeof event.sessionId === "string" && event.sessionId) sessionId = event.sessionId;
        return sessionId ? [{ kind: "progress", text: `session ${sessionId}` }] : [];
      }
      case "status": {
        const phase = event.phase;
        if (phase === "turn_start") return [{ kind: "progress", text: `turn ${String(event.turn ?? "?")}` }];
        if (phase === "turn_end") return [{ kind: "progress", text: `turn ${String(event.turn ?? "?")} ended (${String(event.reason ?? "done")})` }];
        return [];
      }
      case "text": {
        if (typeof event.text !== "string" || !event.text) return [];
        texts.push(event.text);
        return [{ kind: "log", text: event.text }];
      }
      case "tool_call": {
        toolCalls += 1;
        const tool = typeof event.tool === "string" ? event.tool : "tool";
        const input = brief(event.input);
        return [{ kind: "log", text: `
\u25B8 ${tool}${input && input !== "{}" ? ` ${input}` : ""}
` }];
      }
      case "tool_result": {
        if (event.status !== "error") return [];
        return [{ kind: "error", text: `
\u2717 ${brief(event.result, 400)}
` }];
      }
      case "final": {
        if (typeof event.text === "string") finalText = event.text;
        return [];
      }
      case "error": {
        errorText = typeof event.message === "string" ? event.message : "remote dsh reported an error";
        return [{ kind: "error", text: `
${errorText}
` }];
      }
      default:
        return [];
    }
  };
  const consumeLine = (line) => {
    if (!line) return [];
    if (line.charCodeAt(0) === 123) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.type === "string") {
          sawJson = true;
          return handleEvent(parsed);
        }
      } catch {
      }
    }
    raw = (raw + line + "\n").slice(-MAX_RAW);
    return [];
  };
  return {
    push(chunk) {
      buffer += chunk;
      const updates = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        for (const update of consumeLine(line)) updates.push(update);
        index = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_RAW) {
        raw = (raw + buffer).slice(-MAX_RAW);
        buffer = "";
      }
      return updates;
    },
    finish({ exitCode, aborted, stderr }) {
      if (buffer) for (const update of consumeLine(buffer.replace(/\r$/, ""))) void update;
      buffer = "";
      const answer = (finalText ?? (sawJson ? texts.join("") : raw.trim())).slice(0, MAX_ANSWER);
      const diagnostics = (errorText ?? (stderr ?? "").trim()).slice(-8e3);
      const status = aborted ? "killed" : errorText !== void 0 || exitCode !== 0 ? "failed" : "completed";
      return {
        status,
        answer,
        ...sessionId === void 0 ? {} : { sessionId },
        toolCalls,
        ...status === "completed" ? {} : { error: diagnostics || `remote dsh exited with code ${String(exitCode)}` }
      };
    }
  };
}

// src/runner.ts
import { StringDecoder } from "node:string_decoder";
function createRunner(subprocess, options = {}) {
  const active = options.active ?? /* @__PURE__ */ new Set();
  const maxOutput = Math.min(Math.max(options.maxOutput ?? 262144, 4096), 4194304);
  return async function run(argv, runOptions = {}) {
    const { signal, stdin, timeoutMs = 12e4, onOutput } = runOptions;
    signal?.throwIfAborted();
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.includes("\0"))) {
      throw new Error("Invalid process argv");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Remote process deadline exceeded"));
    }, Math.min(Math.max(timeoutMs, 1e3), 864e5));
    timer.unref?.();
    let child;
    try {
      const executable = await subprocess.resolveExecutable(argv[0], void 0, controller.signal);
      child = subprocess.spawn({
        argv: [executable, ...argv.slice(1)],
        signal: controller.signal,
        graceMs: 3e3,
        stdio: { stdin: stdin === void 0 ? "ignore" : { data: stdin }, stdout: "pipe", stderr: "pipe" }
      });
      active.add(child);
      const outputs = { stdout: "", stderr: "" };
      const readers = ["stdout", "stderr"].map(async (stream) => {
        const source = child?.[stream];
        const decoder = new StringDecoder("utf8");
        const consume = (text) => {
          if (!text) return;
          outputs[stream] = (outputs[stream] + text).slice(-maxOutput);
          onOutput?.({ stream, text });
        };
        try {
          if (source) for await (const bytes of source) consume(decoder.write(Buffer.from(bytes)));
          consume(decoder.end());
        } catch (error) {
          child?.terminate();
          throw error;
        }
      });
      const settled = await Promise.allSettled([child.done, ...readers]);
      const rejected = settled.find((item) => item.status === "rejected");
      if (rejected && rejected.status === "rejected") throw rejected.reason;
      if (timedOut) throw new Error(`Remote process timed out after ${timeoutMs} ms`);
      signal?.throwIfAborted();
      const outcome = settled[0].status === "fulfilled" ? settled[0].value : { exitCode: null };
      return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: outputs.stdout, stderr: outputs.stderr };
    } finally {
      try {
        if (child) await child.waitForExit();
        if (timedOut) throw new Error(`Remote process timed out after ${timeoutMs} ms`);
        signal?.throwIfAborted();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
        if (child) active.delete(child);
      }
    }
  };
}

// src/shell.ts
var CONTROL = /[\u0000-\u001f\u007f]/;
function assertPlain(value, label) {
  if (typeof value !== "string" || CONTROL.test(value)) throw new Error(`${label} must be a string without control characters`);
  return value;
}
function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("value must be a string without NUL characters");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function sshTargetOf(instance) {
  return {
    host: instance.host,
    ...instance.user === void 0 ? {} : { user: instance.user },
    ...instance.port === void 0 ? {} : { port: instance.port },
    ...instance.identityFile === void 0 ? {} : { identityFile: instance.identityFile },
    ...instance.proxyJump === void 0 ? {} : { proxyJump: instance.proxyJump }
  };
}
function sshArgv(target, remoteCommand, options) {
  if (typeof remoteCommand !== "string" || remoteCommand.includes("\0")) throw new Error("remote command must be a string without NUL characters");
  if (!target.host) throw new Error("host is required");
  if (target.host.startsWith("-")) throw new Error("host must not start with -");
  const argv = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1e3))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4"
  ];
  if (target.port !== void 0) argv.push("-p", String(target.port));
  if (target.identityFile) argv.push("-i", assertPlain(target.identityFile, "identityFile"));
  if (target.proxyJump) argv.push("-J", assertPlain(target.proxyJump, "proxyJump"));
  if (target.user) argv.push("-l", assertPlain(target.user, "user"));
  argv.push("--", target.host, remoteCommand);
  return argv;
}
function wrapInShell(instance, script) {
  if (instance.shell === "") return script;
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`;
}
function remoteTaskCommand(instance, sessionId) {
  const steps = [];
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`);
  const argv = [instance.dsh, "--profile", instance.profile, "--json"];
  if (sessionId !== void 0) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("sessionId may only contain A-Za-z0-9, _ and -");
    argv.push("--session-id", sessionId);
  }
  steps.push(`exec ${argv.map((value) => shellQuote(value)).join(" ")}`);
  return wrapInShell(instance, steps.join(" && "));
}
function probeScript(instance) {
  const dsh = shellQuote(instance.dsh);
  return [
    'home="${DSH_HOME:-$HOME/.dsh}"',
    `printf 'probe\\tversion\\t%s\\n' "$(${dsh} --version 2>&1 | head -n 1)"`,
    `printf 'probe\\tos\\t%s\\n' "$(uname -srm 2>&1)"`,
    `printf 'probe\\tpath\\t%s\\n' "$(command -v ${dsh} 2>/dev/null || printf missing)"`,
    `printf 'probe\\thome\\t%s\\n' "$home"`,
    `printf 'probe\\tcwd\\t%s\\n' "$(pwd)"`,
    `printf 'probe\\tprofile\\t%s\\n' "$([ -f "$home/profiles/${instance.profile}/package.json" ] && printf present || printf missing)"`
  ].join("\n");
}
function remoteProbeCommand(instance) {
  return wrapInShell(instance, probeScript(instance));
}
function parseProbeOutput(stdout) {
  const facts = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("probe	")) continue;
    const [, key, ...rest] = line.split("	");
    if (!key || rest.length === 0) continue;
    const value = rest.join("	").trim();
    if (value) facts[key] = value;
  }
  return {
    ...facts.version === void 0 ? {} : { version: facts.version },
    ...facts.os === void 0 ? {} : { os: facts.os },
    ...facts.path === void 0 ? {} : { dshPath: facts.path },
    ...facts.home === void 0 ? {} : { dshHome: facts.home },
    ...facts.cwd === void 0 ? {} : { cwd: facts.cwd },
    ...facts.profile === void 0 ? {} : { profile: facts.profile }
  };
}

// src/tool.ts
var ACTIONS = ["instances", "add", "remove", "probe", "ask", "jobs", "status", "cancel"];
var READ_ACTIONS = /* @__PURE__ */ new Set(["instances", "probe", "jobs", "status"]);
var NATIVE_ACTIONS = /* @__PURE__ */ new Set(["add", "remove", "ask"]);
var FIELDS = {
  action: {
    type: "string",
    enum: ACTIONS,
    description: "instances lists registered devices with their last probe; add/remove edit the device list; probe checks ssh reachability, remote dsh version, and the profile directory; ask dispatches a task to the remote DSH agent as a background job; jobs lists this session\u2019s remote jobs; status/cancel use a jobId."
  },
  name: { type: "string", description: "Registered device name from instances, e.g. laptop. Required by add/remove/probe/ask; `add` creates or replaces it." },
  host: { type: "string", description: "For add: remote host name, IP address, or ssh config alias. Never a URL." },
  user: { type: "string", description: "For add: ssh login name. Omit to let ssh config decide." },
  port: { type: "integer", description: "For add: ssh port, 1-65535. Omit for the ssh default." },
  identityFile: { type: "string", description: "For add: absolute path to a local private key for `ssh -i`. Omit to let ssh config and the agent decide. Key contents are never read." },
  proxyJump: { type: "string", description: "For add: `ssh -J` jump target as [user@]host[:port]." },
  profile: { type: "string", description: "For add: remote dsh profile to run, default headless. That profile must exist on the remote device." },
  dsh: { type: "string", description: "For add: remote dsh executable name or absolute path, default dsh. Use an absolute path when a login shell cannot see it." },
  shell: { type: "string", description: "For add: login shell that wraps the remote command, default bash; an empty string runs it directly." },
  cwd: { type: "string", description: "For add: remote working directory for dispatched tasks. Default is the ssh login directory." },
  note: { type: "string", description: "For add: short human note shown in the Settings panel." },
  prompt: { type: "string", description: "For ask: the task text handed to the remote DSH agent. It travels over stdin, never inside a shell command line." },
  sessionId: { type: "string", description: "For ask: continue an existing remote dsh session id instead of starting a fresh one." },
  jobId: { type: "string", description: "For status/cancel: the jobId returned by ask or listed by jobs." },
  from: { type: "integer", description: "For status: output byte cursor; default 0. Continue with output.next." }
};
var parameters = {
  type: "object",
  properties: Object.fromEntries(Object.entries(FIELDS).map(([key, spec]) => [key, {
    type: spec.type,
    ...spec.enum === void 0 ? {} : { enum: spec.enum },
    description: spec.description
  }])),
  required: ["action"],
  additionalProperties: false
};
var TOOL_DESCRIPTION = [
  "Connect to other devices\u2019 DSH instances over SSH and dispatch work to them.",
  "Each registered instance is a device running dsh; ask hands one prompt to that device\u2019s DSH agent (dsh --profile <profile> --json) and streams its progress as an ordinary background job, so several instances and several tasks can run in parallel.",
  "instances lists devices, add/remove edit the list, probe checks ssh reachability plus remote dsh version and profile directory, ask starts a job, and jobs/status/cancel track or stop that job.",
  "The prompt is piped over stdin, so no task text reaches a remote shell command line. add/remove/ask are native operations and need Full Access or a one-shot user approval; read-only actions do not.",
  "SSH authentication must be non-interactive: keys or an ssh-agent, never a password. A first connection to an unknown host key fails until `ssh <host>` has been accepted manually."
].join(" ");
function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A remote instance request must be an object");
  const source = input;
  if (typeof source.action !== "string" || !ACTIONS.includes(source.action)) throw new Error("Unknown remote instance action");
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const spec = FIELDS[key];
    if (!spec) throw new Error("Unknown remote instance request field");
    if (spec.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== spec.type) throw new Error(`Invalid remote instance field: ${key}`);
    if (typeof value === "string" && (value.length > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error(`Invalid remote instance field: ${key}`);
    result[key] = value;
  }
  return result;
}
function approvalSubject(args) {
  if (args.action === "ask") return `ask ${String(args.name)}${args.sessionId ? ` session=${String(args.sessionId)}` : ""}`;
  if (args.action === "add") return `add ${String(args.name)} -> ${String(args.user ?? "")}${String(args.user) ? "@" : ""}${String(args.host)}${args.port ? `:${String(args.port)}` : ""}`;
  return `${String(args.action)} ${String(args.name)}`;
}

// src/service.ts
var MAX_PROMPT = 65536;
var MAX_JOBS_LISTED = 20;
var MAX_STATUS_BYTES = 32e3;
var MAX_REMEMBERED = 64;
function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function requireString(value, field) {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  return value;
}
function firstLine(text) {
  return (text.split("\n").find((line) => line.trim()) ?? "").replace(/\s+/g, " ").trim();
}
function tailChunks(chunks, budget) {
  let remaining = budget;
  let truncated = false;
  const kept = [];
  for (const chunk of [...chunks].reverse()) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = chunk.text.slice(-remaining);
    remaining -= text.length;
    if (text.length < chunk.text.length) truncated = true;
    kept.unshift({ ...chunk, text });
  }
  if (truncated) kept.unshift({ at: kept[0]?.at ?? 0, text: "\u2026[earlier output omitted]\n" });
  return { chunks: kept, truncated };
}
var RemoteInstanceService = class {
  constructor(ctx, settings, overrides = {}) {
    this.ctx = ctx;
    this.settings = settings;
    this.store = overrides.store ?? new InstanceStore({ file: settings.storeFile });
    this.runner = overrides.runner ?? createRunner(ctx.subprocess, { active: this.active });
  }
  ctx;
  settings;
  /** 本插件启动的作业及其 owner 会话。 / Jobs this plugin started keyed by owning session. */
  ownedJobs = /* @__PURE__ */ new Map();
  /** 已结束作业的最终负载。 / Final payloads of settled jobs. */
  results = /* @__PURE__ */ new Map();
  /** 作业上下文。 / Job contexts. */
  contexts = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Set();
  active = /* @__PURE__ */ new Set();
  lifetime = new AbortController();
  store;
  runner;
  sealed = false;
  seeded = false;
  /** 设备清单文件路径。 / The device-list path. */
  get storeDisplayPath() {
    return displayPath(this.store.path);
  }
  /**
   * 执行一个动作。`ui` 来源只允许清单与探测，且不索取审批。
   * Execute one action. The `ui` source may only manage the list and probe, and
   * never asks for approval.
   */
  async execute(input, options = {}) {
    const args = validateRequest(input);
    if (this.sealed) throw new Error("Remote instance plugin is unloading");
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    switch (args.action) {
      case "instances":
        return this.list();
      case "probe":
        return this.probe(args, signal);
      case "add":
        return this.add(args, { ...options, signal });
      case "remove":
        return this.remove(args, { ...options, signal });
      case "ask":
        return this.ask(args, { ...options, signal });
      case "jobs":
        return this.listJobs(this.requireAgent(options.agent));
      case "status":
        return this.status(args, this.requireAgent(options.agent));
      case "cancel":
        return this.cancel(args, this.requireAgent(options.agent));
      default:
        throw new Error("Unknown remote instance action");
    }
  }
  /** 已登记的设备及其最近探测结论。 / Registered devices with their last probe. */
  async list() {
    const snapshot = await this.load();
    return {
      store: this.storeDisplayPath,
      instances: [...snapshot.instances.values()].sort((left, right) => left.name.localeCompare(right.name)).map(instanceSummary),
      ...snapshot.skipped.length === 0 ? {} : { skipped: snapshot.skipped }
    };
  }
  /** 探测一台设备：ssh 连通性、远端 dsh 版本、profile 目录与工作目录。 / Probe one device. */
  async probe(args, signal) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const started = Date.now();
    let facts;
    let stderr = "";
    let message;
    let ok = false;
    try {
      const result = await this.runner(
        sshArgv(sshTargetOf(instance), remoteProbeCommand(instance), { connectTimeoutMs: this.settings.connectTimeoutMs }),
        { signal, timeoutMs: this.settings.probeTimeoutMs }
      );
      facts = parseProbeOutput(result.stdout);
      stderr = result.stderr.trim().slice(-4e3);
      ok = result.exitCode === 0 && facts.version !== void 0 && facts.version !== "missing" && !/not found/i.test(facts.version);
      if (!ok) message = stderr || (result.exitCode === 0 ? "the remote device reported no dsh version" : `ssh exited with code ${String(result.exitCode)}`);
      else if (facts.profile === "missing") message = `the remote device has no profile "${instance.profile}"; create it there or register another profile`;
    } catch (error) {
      if (signal.aborted) throw error;
      message = safeMessage(error);
    }
    const probe = {
      at: Date.now(),
      ok,
      ...facts?.version === void 0 ? {} : { version: facts.version },
      ...facts?.os === void 0 ? {} : { os: facts.os },
      ...message === void 0 ? {} : { message }
    };
    const stored = await this.recordProbe(instance, probe);
    return {
      instance: instanceSummary(stored),
      ok,
      ...facts?.version === void 0 ? {} : { version: facts.version },
      ...facts?.os === void 0 ? {} : { os: facts.os },
      ...facts?.dshPath === void 0 ? {} : { dshPath: facts.dshPath },
      ...facts?.dshHome === void 0 ? {} : { dshHome: facts.dshHome },
      ...facts?.cwd === void 0 ? {} : { cwd: facts.cwd },
      ...facts?.profile === void 0 ? {} : { profile: facts.profile },
      ...message === void 0 ? {} : { message },
      ...stderr ? { stderr } : {},
      elapsedMs: Date.now() - started
    };
  }
  /** 新增或替换一台设备。 / Add or replace one device. */
  async add(args, options) {
    const snapshot = await this.load();
    const existing = snapshot.instances.get(String(args.name ?? ""));
    await this.authorize(args, options);
    const instance = validateInstance(
      {
        name: args.name,
        host: args.host,
        user: args.user,
        port: args.port,
        identityFile: args.identityFile,
        proxyJump: args.proxyJump,
        profile: args.profile,
        dsh: args.dsh,
        shell: args.shell,
        cwd: args.cwd,
        note: args.note
      },
      { existing }
    );
    await this.store.update((instances) => {
      instances.set(instance.name, instance);
    });
    return { instance: instanceSummary(instance), replaced: existing !== void 0 };
  }
  /** 移除一台设备。 / Remove one device. */
  async remove(args, options) {
    const name2 = requireString(args.name, "name");
    await this.authorize(args, options);
    let existed = false;
    await this.store.update((instances) => {
      existed = instances.delete(name2);
    });
    return { removed: name2, existed };
  }
  /** 把一次任务派发给远端 DSH agent，作为本会话的并行后台作业。 / Dispatch one task as a parallel background job. */
  async ask(args, options) {
    const agent = this.requireAgent(options.agent);
    const instance = await this.findInstance(requireString(args.name, "name"));
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) throw new Error("prompt is required");
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too large (max ${MAX_PROMPT} characters)`);
    const sessionId = args.sessionId === void 0 ? void 0 : String(args.sessionId);
    const command = remoteTaskCommand(instance, sessionId);
    await this.authorize(args, options);
    const argv = sshArgv(sshTargetOf(instance), command, { connectTimeoutMs: this.settings.connectTimeoutMs });
    const controller = new AbortController();
    const owner = agent.id;
    const label = `Remote ${instance.name}: ${firstLine(prompt).slice(0, 60)}`;
    const jobId = this.ctx.jobs.start({
      kind: "remote",
      owner,
      label,
      outputLimitBytes: this.settings.maxOutputBytes,
      ...options.source === "tool" && options.callId ? { toolCall: { callId: options.callId, rootCallId: options.rootCallId ?? options.callId } } : {},
      run: (job) => {
        const promise = Promise.resolve().then(async () => {
          const parser = createTaskParser();
          let stderr = "";
          try {
            job.updateProgress(`connecting to ${instance.name}`);
            const result = await this.runner(argv, {
              signal: controller.signal,
              stdin: prompt,
              timeoutMs: this.settings.taskTimeoutMs,
              onOutput: ({ stream, text }) => {
                if (stream !== "stdout") {
                  stderr = (stderr + text).slice(-32768);
                  return;
                }
                for (const update of parser.push(text)) {
                  if (update.kind === "progress") job.updateProgress(update.text);
                  else job.append(update.text, { channel: update.kind === "error" ? "stderr" : "log" });
                }
              }
            });
            const parsed = parser.finish({ exitCode: result.exitCode, aborted: controller.signal.aborted, stderr });
            const payload = {
              instance: instance.name,
              status: parsed.status,
              answer: parsed.answer,
              toolCalls: parsed.toolCalls,
              exitCode: result.exitCode,
              ...parsed.sessionId === void 0 ? {} : { sessionId: parsed.sessionId }
            };
            this.remember(job.id, payload);
            if (parsed.status === "completed") {
              job.updateProgress("completed");
              return { status: "completed", result: JSON.stringify(payload) };
            }
            const detail = (parsed.error ?? "").slice(-8e3) || `remote dsh exited with code ${String(result.exitCode)}`;
            job.append(`
${detail}
`, { channel: "stderr" });
            return { status: parsed.status, detail: detail.slice(0, 2e3) };
          } catch (error) {
            const killed = controller.signal.aborted;
            const message = safeMessage(error).slice(-8e3);
            this.remember(job.id, { instance: instance.name, status: killed ? "killed" : "failed", answer: "", error: message });
            if (!killed) job.append(`
${message}
`, { channel: "stderr" });
            return { status: killed ? "killed" : "failed", detail: message.slice(0, 2e3) };
          }
        });
        this.pending.add(promise);
        promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
        return { cancel: (reason) => controller.abort(new Error(reason ?? "Remote task cancelled")), done: promise };
      }
    });
    this.ownedJobs.set(jobId, owner);
    this.contexts.set(jobId, {
      instance: instance.name,
      profile: instance.profile,
      ...sessionId === void 0 ? {} : { sessionId },
      prompt: firstLine(prompt).slice(0, 200)
    });
    return { jobId, instance: instance.name, status: "running", ...sessionId === void 0 ? {} : { sessionId } };
  }
  /** 本会话的远程作业。 / Remote jobs of this session. */
  listJobs(agent) {
    const jobs = [];
    for (const [id, owner] of [...this.ownedJobs].reverse()) {
      if (owner !== agent.id) continue;
      const context = this.contexts.get(id);
      if (!context) continue;
      try {
        jobs.push({ ...this.ctx.jobs.get(id, agent.id), context: { ...context } });
      } catch {
        this.forget(id);
      }
      if (jobs.length === MAX_JOBS_LISTED) break;
    }
    return { jobs };
  }
  /** 读取作业状态与保留输出。 / Read one job's state and retained output. */
  status(args, agent) {
    const jobId = this.owned(requireString(args.jobId, "jobId"), agent);
    const job = this.ctx.jobs.get(jobId, agent.id);
    const output = this.ctx.jobs.readAt(jobId, typeof args.from === "number" ? args.from : 0, agent.id);
    const { chunks, truncated } = tailChunks(output.chunks, MAX_STATUS_BYTES);
    return { job, output: { chunks, next: output.next, lossy: output.lossy || truncated }, result: this.results.get(jobId) ?? null };
  }
  /** 取消一个远程作业。 / Cancel one remote job. */
  cancel(args, agent) {
    const jobId = this.owned(requireString(args.jobId, "jobId"), agent);
    return { jobId, status: this.ctx.jobs.kill(jobId, agent.id, "Remote task cancelled by caller") };
  }
  /** 停止全部在跑任务并等待进程退出。 / Stop every live task and wait for the processes. */
  async dispose() {
    this.sealed = true;
    this.lifetime.abort(new Error("Remote instance plugin unloaded"));
    for (const [id, owner] of this.ownedJobs) {
      try {
        this.ctx.jobs.kill(id, owner, "Remote instance plugin unloaded");
      } catch {
      }
    }
    for (const child of this.active) child.terminate();
    await Promise.allSettled([...this.pending, ...[...this.active].map((child) => child.waitForExit())]);
    this.results.clear();
    this.ownedJobs.clear();
    this.contexts.clear();
  }
  requireAgent(agent) {
    if (!agent) throw new Error("Choose a live session first");
    return agent;
  }
  async load() {
    const snapshot = await this.store.load();
    if (snapshot.exists || this.seeded || this.settings.seed.length === 0) return snapshot;
    this.seeded = true;
    const instances = /* @__PURE__ */ new Map();
    for (const entry of this.settings.seed) {
      const instance = validateInstance(entry);
      instances.set(instance.name, instance);
    }
    await this.store.save(instances);
    return { instances, exists: true, skipped: snapshot.skipped };
  }
  async findInstance(name2) {
    if (!name2) throw new Error("name is required");
    const snapshot = await this.load();
    const instance = snapshot.instances.get(name2);
    if (!instance) throw new Error(`Unknown remote instance "${name2}"; call instances to list the registered devices`);
    return instance;
  }
  async recordProbe(instance, probe) {
    const updated = { ...instance, lastProbe: probe };
    await this.store.update((instances) => {
      if (instances.has(instance.name)) instances.set(instance.name, updated);
    });
    return updated;
  }
  owned(jobId, agent) {
    if (this.ownedJobs.get(jobId) !== agent.id) throw new Error("Unknown or foreign remote job");
    return jobId;
  }
  remember(jobId, payload) {
    this.results.set(jobId, payload);
    while (this.results.size > MAX_REMEMBERED) {
      const oldest = this.results.keys().next().value;
      if (oldest === void 0) break;
      this.results.delete(oldest);
    }
  }
  forget(jobId) {
    this.ownedJobs.delete(jobId);
    this.contexts.delete(jobId);
    this.results.delete(jobId);
  }
  /**
   * 原生操作授权：Full Access 会话直接放行，否则要求一次明确的一次性批准；界面点击已由用户本人完成。
   * Native-operation grant: a Full Access session passes, otherwise one explicit
   * one-shot approval is required. A UI click is already the human decision.
   */
  async authorize(args, options) {
    if (!NATIVE_ACTIONS.has(String(args.action))) return;
    if (options.source === "ui") return;
    const agent = this.requireAgent(options.agent);
    options.signal?.throwIfAborted();
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session });
    if (policy.mode === "danger-full-access") return;
    const subject = approvalSubject(args);
    const outcome = await this.ctx.approval.request({
      agent,
      toolName: "remote_instance",
      callId: options.callId,
      signal: options.signal,
      reason: `Remote instance ${subject}. This uses native ssh from this host to another device, runs that device's dsh agent, and may write configuration, caches, and session state there. Allow this exact operation once?`,
      displayReason: {
        en: `Allow ${subject} over SSH for this operation?`,
        zh: `\u662F\u5426\u5141\u8BB8\u672C\u6B21\u901A\u8FC7 SSH \u6267\u884C ${subject}\uFF1F`
      }
    });
    if (outcome !== "allowed-once") throw new Error(`Remote instance operation not authorized (${outcome})`);
  }
};

// src/host.ts
var name = "remote-instance";
var inject = ["tools", "subprocess", "jobs", "sandboxPolicy", "approval", "agents", "webServer", "connection"];
var TOOL_NAME = "remote_instance";
function apply(ctx, config) {
  const settings = resolveSettings(config);
  const service = new RemoteInstanceService(ctx, settings);
  ctx.effect(() => () => service.dispose(), "remote-instance.dispose");
  ctx.effect(() => ctx.jobs.attachController("remote-instance"), "remote-instance.jobs");
  const originOf = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return "";
    }
  };
  if (typeof ctx.webServer?.register === "function") {
    ctx.effect(() => {
      const routes = [
        ctx.webServer.register({ kind: "exact", path: OBSERVE_PATH, handler: createObserveHandler(service, originOf) }),
        ctx.webServer.register({ kind: "exact", path: ACTION_PATH, handler: createActionHandler(service, originOf) })
      ];
      return () => {
        for (const dispose of routes.reverse()) dispose();
      };
    }, "remote-instance.http");
  }
  ctx.on("agent/disposed", ({ agent }) => {
    for (const [id, owner] of service.ownedJobs) {
      if (owner !== agent.id) continue;
      service.ownedJobs.delete(id);
      service.contexts.delete(id);
      service.results.delete(id);
    }
  });
  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters,
    output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    isConcurrencySafe: (args) => READ_ACTIONS.has(String(args?.action)),
    execute: async (args, exec) => service.execute(args, {
      agent: exec.agent,
      signal: exec.signal,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      source: "tool"
    })
  }), "remote-instance.tool");
}
export {
  ACTIONS,
  ACTION_PATH,
  InstanceStore,
  NAME_PATTERN,
  OBSERVE_PATH,
  READ_ACTIONS,
  RemoteInstanceService,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  apply,
  createActionHandler,
  createObserveHandler,
  createRunner,
  createTaskParser,
  displayPath,
  displayTarget,
  inject,
  instanceSummary,
  name,
  parseProbeOutput,
  remoteProbeCommand,
  remoteTaskCommand,
  resolveDshHome,
  resolveSettings,
  restoreInstance,
  sameLoopbackOrigin,
  shellQuote,
  sshArgv,
  validateInstance,
  validateRequest
};
