// src/bridge.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

// src/history.ts
import { zstdDecompressSync } from "node:zlib";

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
  const auth = options.auth ?? "key";
  const argv = [
    "ssh",
    "-T",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1e3))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4"
  ];
  if (auth === "password") {
    argv.push("-o", "BatchMode=no", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "NumberOfPasswordPrompts=1");
  } else {
    argv.push("-o", "BatchMode=yes");
  }
  if (target.port !== void 0) argv.push("-p", String(target.port));
  if (target.identityFile) argv.push("-i", assertPlain(target.identityFile, "identityFile"));
  if (target.proxyJump) argv.push("-J", assertPlain(target.proxyJump, "proxyJump"));
  if (target.user) argv.push("-l", assertPlain(target.user, "user"));
  argv.push("--", target.host, remoteCommand);
  return argv;
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
  const platform = facts.platform === "windows" ? "windows" : facts.platform === "posix" ? "posix" : void 0;
  return {
    ...facts.version === void 0 ? {} : { version: facts.version },
    ...facts.os === void 0 ? {} : { os: facts.os },
    ...facts.path === void 0 ? {} : { dshPath: facts.path },
    ...facts.home === void 0 ? {} : { dshHome: facts.home },
    ...facts.cwd === void 0 ? {} : { cwd: facts.cwd },
    ...facts.profile === void 0 ? {} : { profile: facts.profile },
    ...platform === void 0 ? {} : { platform }
  };
}
var ASKPASS_SCRIPT = `#!/bin/sh
printf '%s\\n' "\${DSH_REMOTE_PASSWORD-}"
`;
function askpassEnv(helperPath) {
  return {
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0"
  };
}

// src/platform.ts
function psQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("value must be a string without NUL characters");
  return `'${value.replace(/'/g, "''")}'`;
}
function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
function powershellCommand(script) {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`;
}
function requireSessionId(sessionId) {
  if (sessionId === void 0) return void 0;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("sessionId may only contain A-Za-z0-9, _ and -");
  return sessionId;
}
function posixTaskScript(instance, sessionId) {
  const steps = [];
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`);
  const argv = [instance.dsh, "--profile", instance.profile, "--json"];
  const id = requireSessionId(sessionId);
  if (id !== void 0) argv.push("--session-id", id);
  steps.push(`exec ${argv.map((value) => shellQuote(value)).join(" ")}`);
  return steps.join(" && ");
}
function posixTaskCommand(instance, sessionId) {
  const script = posixTaskScript(instance, sessionId);
  if (!instance.shell) return script;
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`;
}
function posixProbeScript(instance) {
  const dsh = shellQuote(instance.dsh);
  return [
    'home="${DSH_HOME:-$HOME/.dsh}"',
    `printf 'probe\\tversion\\t%s\\n' "$(${dsh} --version 2>&1 | head -n 1)"`,
    `printf 'probe\\tos\\t%s\\n' "$(uname -srm 2>&1)"`,
    `printf 'probe\\tpath\\t%s\\n' "$(command -v ${dsh} 2>/dev/null || printf missing)"`,
    `printf 'probe\\thome\\t%s\\n' "$home"`,
    `printf 'probe\\tcwd\\t%s\\n' "$(pwd)"`,
    `printf 'probe\\tprofile\\t%s\\n' "$([ -f "$home/profiles/${instance.profile}/package.json" ] && printf present || printf missing)"`,
    "printf 'probe\\tplatform\\tposix\\n'"
  ].join("\n");
}
function posixProbeCommand(instance) {
  const script = posixProbeScript(instance);
  if (!instance.shell) return script;
  return `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`;
}
function windowsProbeScript(instance) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$t = [char]9",
    `$dsh = ${psQuote(instance.dsh)}`,
    "if ($env:DSH_HOME) { $home = $env:DSH_HOME } else { $home = Join-Path $env:USERPROFILE '.dsh' }",
    "$cmd = Get-Command $dsh | Select-Object -First 1",
    `"probe\${t}version\${t}$(& $dsh --version 2>&1 | Select-Object -First 1)"`,
    `"probe\${t}os\${t}$([Environment]::OSVersion.VersionString)"`,
    `"probe\${t}path\${t}$(if ($cmd) { $cmd.Source } else { 'missing' })"`,
    `"probe\${t}home\${t}$home"`,
    `"probe\${t}cwd\${t}$((Get-Location).Path)"`,
    `"probe\${t}profile\${t}$(if (Test-Path (Join-Path $home 'profiles/${instance.profile}/package.json')) { 'present' } else { 'missing' })"`,
    `"probe\${t}platform\${t}windows"`
  ].join("\n");
}
function windowsProbeCommand(instance) {
  return powershellCommand(windowsProbeScript(instance));
}
function windowsTaskScript(instance, sessionId) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8"
  ];
  if (instance.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(instance.cwd)}`);
  const args = [instance.dsh, "--profile", instance.profile, "--json"];
  const id = requireSessionId(sessionId);
  if (id !== void 0) args.push("--session-id", id);
  lines.push(`& ${args.map(psQuote).join(" ")}`);
  lines.push("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }");
  return lines.join("\n");
}
function windowsTaskCommand(instance, sessionId) {
  return powershellCommand(windowsTaskScript(instance, sessionId));
}
function posixAcpCommand(instance) {
  const steps = [];
  if (instance.cwd) steps.push(`cd -- ${shellQuote(instance.cwd)}`);
  steps.push(`exec ${shellQuote(instance.dsh)} ${shellQuote("--profile")} ${shellQuote("acp")}`);
  const script = steps.join(" && ");
  return instance.shell === "" ? script : `${shellQuote(instance.shell)} -lc ${shellQuote(script)}`;
}
function windowsAcpCommand(instance) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8"
  ];
  if (instance.cwd) lines.push(`Set-Location -LiteralPath ${psQuote(instance.cwd)}`);
  lines.push(`& ${[instance.dsh, "--profile", "acp"].map(psQuote).join(" ")}`);
  lines.push("exit $LASTEXITCODE");
  return powershellCommand(lines.join("\n"));
}
function acpCommand(instance, platform) {
  return platform === "windows" ? windowsAcpCommand(instance) : posixAcpCommand(instance);
}
function taskCommand(instance, platform, sessionId) {
  return platform === "windows" ? windowsTaskCommand(instance, sessionId) : posixTaskCommand(instance, sessionId);
}
function probeCommand(instance, platform) {
  return platform === "windows" ? windowsProbeCommand(instance) : posixProbeCommand(instance);
}

// src/history.ts
var MAX_LOG_BYTES = 8 * 1024 * 1024;
var MAX_MESSAGES = 240;
var MAX_TEXT = 2e4;
var MAGIC = [40, 181, 47, 253];
function decompressFrames(buffer) {
  if (buffer.length === 0) return "";
  const starts = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) starts.push(index);
  }
  if (starts.length === 0) throw new Error("the session log has no zstd frame");
  let text = "";
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = starts[index + 1] ?? buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(from, to)).toString("utf8");
    } catch {
    }
  }
  return text;
}
function textOfBlocks(blocks, kinds) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const source = block;
    if (typeof source.type !== "string" || !kinds.includes(source.type)) continue;
    if (typeof source.text === "string" && source.text) parts.push(source.text);
  }
  return parts.join("");
}
function brief(value, limit = 200) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = (text ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text;
}
function parseSessionLog(text) {
  const messages = [];
  let sessionId;
  let cwd;
  let createdAt;
  let events = 0;
  const push = (message) => {
    if (!message.text) return;
    const last = messages[messages.length - 1];
    if (last && last.role === message.role && last.id === void 0 && message.id === void 0 && message.role !== "tool") {
      messages[messages.length - 1] = { ...last, text: (last.text + message.text).slice(-MAX_TEXT) };
      return;
    }
    messages.push({ ...message, text: message.text.slice(0, MAX_TEXT) });
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  };
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let event;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      event = parsed;
    } catch {
      continue;
    }
    events += 1;
    const data = event.data ?? {};
    if (event.type === "session") {
      if (typeof event.id === "string") sessionId = event.id;
      if (typeof event.cwd === "string") cwd = event.cwd;
      if (typeof event.createdAt === "number") createdAt = event.createdAt;
      continue;
    }
    const at = typeof event.time === "number" ? event.time : void 0;
    switch (event.type) {
      case "user/message": {
        const body = textOfBlocks(data.content, ["text"]);
        push({ role: "user", text: body, ...at === void 0 ? {} : { at } });
        break;
      }
      case "assistant/message": {
        const message = data.message ?? {};
        const body = textOfBlocks(message.content, ["text"]);
        const thought = textOfBlocks(message.content, ["reasoning"]);
        if (thought) push({ role: "thought", text: thought, ...at === void 0 ? {} : { at } });
        if (body) push({ role: "assistant", text: body, ...at === void 0 ? {} : { at } });
        break;
      }
      case "tool/call": {
        const name2 = typeof data.name === "string" ? data.name : "tool";
        const args = brief(data.arguments);
        push({
          role: "tool",
          text: `${name2}${args && args !== "{}" ? ` ${args}` : ""}`,
          at: at ?? Date.now(),
          ...typeof data.callId === "string" ? { id: data.callId } : {},
          status: "called"
        });
        break;
      }
      case "tool/result": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : void 0;
        if (id === void 0) break;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (!message || message.id !== id) continue;
          messages[index] = { ...message, status: "done" };
          break;
        }
        break;
      }
      default:
        break;
    }
  }
  return { messages, events, ...sessionId === void 0 ? {} : { sessionId }, ...cwd === void 0 ? {} : { cwd }, ...createdAt === void 0 ? {} : { createdAt } };
}
function historyCommand(platform, home, sessionId, limit = MAX_LOG_BYTES) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("sessionId may only contain A-Za-z0-9, _ and -");
  const base = home && home.trim() ? home.trim() : "${DSH_HOME:-$HOME/.dsh}";
  if (platform === "windows") {
    const script2 = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      `$home = ${home && home.trim() ? psQuote(home.trim()) : `if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }`}`,
      `$sid = ${psQuote(sessionId)}`,
      `$dir = Get-ChildItem (Join-Path $home 'sessions') -Directory | ForEach-Object { Get-ChildItem $_.FullName -Directory } | Where-Object { $_.Name -eq $sid } | Select-Object -First 1`,
      "if ($dir) { $chunks = @(); $size = 0; Get-ChildItem $dir.FullName -Filter *.jsonl.zstd | Sort-Object Name | ForEach-Object { if ($size -lt " + String(limit) + ") { $bytes = [IO.File]::ReadAllBytes($_.FullName); $size += $bytes.Length; $chunks += $bytes } }; if ($chunks.Count -gt 0) { [Convert]::ToBase64String([byte[]]$chunks) } }"
    ].join("\n");
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script2, "utf16le").toString("base64")}`;
  }
  const homeExpr = home && home.trim() ? shellQuote(home.trim()) : '"${DSH_HOME:-$HOME/.dsh}"';
  const script = [
    `home=${homeExpr}`,
    `dir=$(find "$home/sessions" -mindepth 2 -maxdepth 2 -type d -name ${shellQuote(sessionId)} 2>/dev/null | head -n 1)`,
    '[ -n "$dir" ] || exit 0',
    `cat "$dir"/*.jsonl.zstd 2>/dev/null | head -c ${limit} | base64 | tr -d '\\n'`
  ].join("\n");
  return script;
}

// src/bridge.ts
var BODY_LIMIT = 1048576;
var SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}
async function ensureToken(file) {
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${token}
`, { mode: 384 });
  await chmod(file, 384);
  return token;
}
async function sessionLogFiles(dshHome, sessionId) {
  const root = join(dshHome, "sessions");
  let groups;
  try {
    groups = await readdir(root);
  } catch {
    return [];
  }
  for (const group of groups) {
    const directory = join(root, group, sessionId);
    try {
      if (!(await stat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }
    let names = [];
    try {
      names = (await readdir(directory)).filter((name2) => name2.endsWith(".jsonl.zstd")).sort();
    } catch {
      continue;
    }
    return names.map((name2) => join(directory, name2));
  }
  return [];
}
async function readHistory(dshHome, sessionId) {
  const files = await sessionLogFiles(dshHome, sessionId);
  if (files.length === 0) return { messages: [] };
  let text = "";
  for (const file of files) text += decompressFrames(await readFile(file));
  const parsed = parseSessionLog(text);
  return {
    messages: parsed.messages,
    ...parsed.cwd === void 0 ? {} : { cwd: parsed.cwd },
    ...parsed.sessionId === void 0 ? {} : { sessionId: parsed.sessionId }
  };
}
function sessionRow(value) {
  if (!value || typeof value !== "object") return void 0;
  const source = value;
  if (typeof source.sessionId !== "string" || !source.sessionId) return void 0;
  return {
    sessionId: source.sessionId,
    ...typeof source.cwd === "string" ? { cwd: source.cwd } : {},
    ...typeof source.updatedAt === "number" ? { updatedAt: source.updatedAt } : {},
    ...typeof source.running === "boolean" ? { running: source.running } : {},
    ...typeof source.blank === "boolean" ? { blank: source.blank } : {},
    ...typeof source.agentAvailable === "boolean" ? { agentAvailable: source.agentAvailable } : {}
  };
}
async function startBridge(ctx, options) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("bridge port must be 0-65535");
  if (options.port === 0) return { port: 0, token: "", close: async () => void 0 };
  const token = await ensureToken(options.tokenFile);
  const host = options.host ?? "127.0.0.1";
  const controller = () => {
    const candidate = ctx.get("sessionController");
    return candidate && typeof candidate === "object" ? candidate : void 0;
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return sendError(res, 401, "missing or wrong bridge token");
      const url = new URL(req.url ?? "/", `http://${host}`);
      const route = `${req.method ?? "GET"} ${url.pathname}`;
      if (route === "GET /v1/info") {
        return sendJson(res, 200, {
          ok: true,
          hostname: hostname(),
          platform: process.platform === "win32" ? "windows" : "posix",
          dshHome: options.dshHome,
          canPrompt: controller() !== void 0,
          node: process.version
        });
      }
      if (route === "GET /v1/sessions") {
        const sessions = controller();
        if (!sessions) return sendError(res, 503, "this host has no session controller");
        const listed = await sessions.list({});
        const rows = listed.items.map(sessionRow).filter((row) => row !== void 0);
        return sendJson(res, 200, { ok: true, sessions: rows });
      }
      if (route === "GET /v1/history") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, "invalid session id");
        const history = await readHistory(options.dshHome, sessionId);
        return sendJson(res, 200, { ok: true, source: history.messages.length > 0 ? "log" : "empty", ...history });
      }
      if (route === "POST /v1/create") {
        const sessions = controller();
        if (!sessions) return sendError(res, 503, "this host has no session controller");
        const body = JSON.parse(await readBody(req) || "{}");
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : void 0;
        const created = await sessions.create(cwd === void 0 ? {} : { cwd });
        return sendJson(res, 200, { ok: true, sessionId: created.sessionId });
      }
      if (route === "POST /v1/prompt") {
        const sessions = controller();
        if (!sessions) return sendError(res, 503, "this host has no session controller");
        const body = JSON.parse(await readBody(req) || "{}");
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const text = typeof body.text === "string" ? body.text : "";
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, "invalid session id");
        if (!text.trim()) return sendError(res, 400, "text is required");
        if (text.length > 2e5) return sendError(res, 400, "text is too large");
        await sessions.prompt({
          requestId: randomBytes(16).toString("hex"),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text }]
        });
        return sendJson(res, 200, { ok: true, accepted: true });
      }
      if (route === "POST /v1/cancel") {
        const sessions = controller();
        if (!sessions) return sendError(res, 503, "this host has no session controller");
        const body = JSON.parse(await readBody(req) || "{}");
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!SESSION_ID.test(sessionId)) return sendError(res, 400, "invalid session id");
        await sessions.cancel({ sessionId });
        return sendJson(res, 200, { ok: true });
      }
      return sendError(res, 404, `unknown bridge route: ${route}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn(`remote-instance bridge: ${message}`);
      if (!res.writableEnded) sendError(res, 500, message.slice(0, 2e3));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    token,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    })
  };
}

// src/http.ts
var OBSERVE_PATH = "/remote-instance/observe";
var ACTION_PATH = "/remote-instance/action";
var UI_READ_ACTIONS = /* @__PURE__ */ new Set(["instances", "jobs", "status", "sessions", "history"]);
var UI_ACTION_ACTIONS = /* @__PURE__ */ new Set(["add", "remove", "probe", "ask", "cancel", "new", "send", "stop", "close"]);
var SESSION_ACTIONS = /* @__PURE__ */ new Set(["jobs", "status", "ask", "cancel"]);
var BODY_LIMIT2 = 65536;
function sendJson2(res, status, value) {
  if (res.writableEnded || res.destroyed) return void 0;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
  return void 0;
}
function readBody2(req, limit, signal) {
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
    sendJson2(res, 503, { ok: false, error: "Browser authentication is unavailable" });
    return false;
  }
  const admission = connection.admit(req);
  if (admission.rejection) {
    sendJson2(res, admission.rejection.status ?? 403, { ok: false, error: "Browser authentication required" });
    return false;
  }
  if (admission.peer?.id !== connection.browserPeer.id) {
    sendJson2(res, 403, { ok: false, error: "This endpoint requires the authenticated browser" });
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
  const source = request;
  if (source.sessionId !== void 0 && (typeof source.sessionId !== "string" || !source.sessionId || source.sessionId.length > 256)) {
    throw new Error("Invalid session id");
  }
  const args = source.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("The request needs an args object");
  return {
    ...source.sessionId === void 0 ? {} : { sessionId: source.sessionId },
    args
  };
}
function sessionOf(service, request) {
  if (request.sessionId === void 0) return void 0;
  const agent = service.ctx.agents.get(request.sessionId);
  if (!agent) throw Object.assign(new Error("Unknown session"), { status: 404 });
  return agent;
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
      const request = envelope(await readBody2(req, BODY_LIMIT2, controller.signal));
      if (!UI_READ_ACTIONS.has(String(request.args.action))) throw new Error("This remote instance observation is not read-only");
      const agent = sessionOf(service, request);
      if (SESSION_ACTIONS.has(String(request.args.action)) && agent === void 0) throw new Error("This remote instance observation needs a session");
      const value = await service.execute(request.args, { source: "ui", signal: controller.signal, ...agent === void 0 ? {} : { agent } });
      return sendJson2(res, 200, { ok: true, value });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return void 0;
      const status = typeof error.status === "number" ? error.status : 400;
      return sendJson2(res, status, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4e3) });
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
      const request = envelope(await readBody2(req, BODY_LIMIT2, controller.signal));
      if (!UI_ACTION_ACTIONS.has(String(request.args.action))) throw new Error("This action is not available from the Settings panel");
      const agent = sessionOf(service, request);
      if (SESSION_ACTIONS.has(String(request.args.action)) && agent === void 0) throw new Error("This action needs a session");
      const value = await service.execute(request.args, { source: "ui", signal: controller.signal, ...agent === void 0 ? {} : { agent } });
      return sendJson2(res, 200, { ok: true, value });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return void 0;
      const status = typeof error.status === "number" ? error.status : 400;
      return sendJson2(res, status, { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4e3) });
    }
  };
}

// src/settings.ts
import { homedir } from "node:os";
import { dirname as dirname3, isAbsolute, join as join2, normalize, sep } from "node:path";

// src/instances.ts
import { mkdir as mkdir2, readFile as readFile2, rename, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
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
  const auth = source.auth === void 0 || source.auth === null || source.auth === "" ? void 0 : source.auth;
  if (auth !== void 0 && auth !== "password" && auth !== "key") throw new Error("auth must be 'password' or 'key'");
  const platform = source.platform === void 0 || source.platform === null || source.platform === "" ? void 0 : source.platform;
  if (platform !== void 0 && platform !== "posix" && platform !== "windows") throw new Error("platform must be 'posix' or 'windows'");
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
    ...auth === void 0 ? {} : { auth },
    ...platform === void 0 ? {} : { platform },
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
    ...instance.auth === void 0 ? {} : { auth: instance.auth },
    ...instance.platform === void 0 ? {} : { platform: instance.platform },
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
      text = await readFile2(this.file, "utf8");
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
    await mkdir2(dirname2(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile2(temporary, body, { encoding: "utf8", mode: 384 });
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
  maxOutputBytes: [4096, 4194304, 262144],
  bridgePort: [0, 65535, 0]
};
var KNOWN_KEYS = /* @__PURE__ */ new Set(["storeFile", "bridgeTokenFile", ...Object.keys(LIMITS), "instances"]);
function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) return join2(homedir(), value.slice(2));
  return value;
}
function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return normalize(configured ? expandHome(configured) : join2(homedir(), ".dsh"));
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
function readBridgeTokenFile(source, storeFile) {
  const value = source.bridgeTokenFile;
  if (value === void 0) return join2(dirname3(storeFile), "remote-instance-bridge-token");
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("remote-instance config: bridgeTokenFile must be a non-empty path");
  }
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) throw new Error("remote-instance config: bridgeTokenFile must be absolute or start with ~");
  return normalize(expanded);
}
function readStoreFile(source) {
  const value = source.storeFile;
  if (value === void 0) return join2(resolveDshHome(), "remote-instances.json");
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
    seed: seed === void 0 ? [] : seed,
    bridgePort: readInteger(source, "bridgePort"),
    bridgeTokenFile: readBridgeTokenFile(source, readStoreFile(source))
  };
}

// src/host.ts
import { dirname as dirname5 } from "node:path";

// src/service.ts
import { chmod as chmod3, mkdtemp, rm, writeFile as writeFile4 } from "node:fs/promises";
import { hostname as hostname2, tmpdir } from "node:os";
import { join as join3 } from "node:path";

// src/acp.ts
var CLIENT_NAME = "dsh-remote-instance";
var CLIENT_VERSION = "1.0.0";
var AcpConnectionError = class extends Error {
};
var AcpClient = class _AcpClient {
  constructor(transport, options) {
    this.transport = transport;
    this.options = options;
  }
  transport;
  options;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  live = /* @__PURE__ */ new Set();
  disposed = false;
  /** 建立连接并完成 `initialize` 握手。 / Connect and complete the `initialize` handshake. */
  static async connect(transport, options = {}) {
    const client = new _AcpClient(transport, options);
    client.read();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
    });
    return client;
  }
  async listSessions(cwd) {
    const result = await this.request("session/list", cwd === void 0 ? {} : { cwd });
    const rows = Array.isArray(result?.sessions) ? result.sessions : [];
    const sessions = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const source = row;
      if (typeof source.sessionId !== "string" || !source.sessionId) continue;
      if (typeof source.cwd !== "string" || !source.cwd) continue;
      sessions.push({
        sessionId: source.sessionId,
        cwd: source.cwd,
        ...typeof source.title === "string" && source.title ? { title: source.title } : {},
        ...typeof source.updatedAt === "string" && source.updatedAt ? { updatedAt: source.updatedAt } : {}
      });
    }
    return sessions;
  }
  async newSession(cwd) {
    const result = await this.request("session/new", { cwd, mcpServers: [] });
    if (typeof result?.sessionId !== "string" || !result.sessionId) throw new AcpConnectionError("session/new returned no session id");
    this.live.add(result.sessionId);
    return result.sessionId;
  }
  async resumeSession(sessionId, cwd) {
    if (this.live.has(sessionId)) return;
    await this.request("session/resume", { sessionId, ...cwd === void 0 ? {} : { cwd }, mcpServers: [] });
    this.live.add(sessionId);
  }
  async prompt(sessionId, text, promptOptions = {}) {
    await this.resumeSession(sessionId);
    const result = await this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { timeoutMs: promptOptions.timeoutMs ?? 30 * 6e4, signal: promptOptions.signal }
    );
    return { stopReason: typeof result?.stopReason === "string" ? result.stopReason : "end_turn" };
  }
  async cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }
  async closeSession(sessionId) {
    try {
      await this.request("session/close", { sessionId });
    } finally {
      this.live.delete(sessionId);
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AcpConnectionError("the ACP connection closed"));
      this.pending.delete(id);
    }
    try {
      this.transport.stdin.end();
    } catch {
    }
    try {
      this.transport.terminate();
    } catch {
    }
    let fallback;
    try {
      await Promise.race([
        this.transport.closed,
        new Promise((resolve) => {
          fallback = setTimeout(resolve, 3e3);
        })
      ]);
    } catch {
    } finally {
      if (fallback !== void 0) clearTimeout(fallback);
    }
  }
  write(message) {
    if (this.disposed) throw new AcpConnectionError("the ACP connection closed");
    this.transport.stdin.write(`${JSON.stringify(message)}
`);
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  request(method, params, options = {}) {
    if (this.disposed) return Promise.reject(new AcpConnectionError("the ACP connection closed"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 3e4;
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
      };
      const entry = {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        timer: setTimeout(() => entry.reject(new AcpConnectionError(`ACP request timed out: ${method}`)), timeoutMs)
      };
      const abort = () => {
        entry.reject(new AcpConnectionError(`ACP request cancelled: ${method}`));
        try {
          this.notify("session/cancel", params);
        } catch {
        }
      };
      if (timeoutMs <= 0) clearTimeout(entry.timer);
      this.pending.set(id, entry);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  read() {
    void (async () => {
      try {
        for await (const line of this.transport.lines) {
          if (this.disposed) break;
          const text = line.trim();
          if (!text) continue;
          let message;
          try {
            message = JSON.parse(text);
          } catch {
            this.options.onWarning?.("ignored an ACP line that was not JSON");
            continue;
          }
          if (!message || typeof message !== "object") continue;
          this.dispatch(message);
        }
      } catch (error) {
        if (!this.disposed) this.options.onWarning?.(`ACP stream ended: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (!this.disposed) {
          for (const [, entry] of this.pending) entry.reject(new AcpConnectionError("the ACP connection closed"));
          this.pending.clear();
        }
      }
    })();
  }
  dispatch(message) {
    const id = typeof message.id === "number" ? message.id : void 0;
    const method = typeof message.method === "string" ? message.method : void 0;
    if (id !== void 0 && method === void 0) {
      const entry = this.pending.get(id);
      if (!entry) return;
      if (message.error && typeof message.error === "object") {
        const failure = message.error;
        entry.reject(new AcpConnectionError(typeof failure.message === "string" ? failure.message : `ACP error ${String(failure.code ?? "unknown")}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (method === void 0) return;
    if (id !== void 0) {
      this.answer(id, method, message.params);
      return;
    }
    this.notification(method, message.params);
  }
  answer(id, method, params) {
    if (method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported agent request: ${method}` } });
      return;
    }
    const request = params ?? {};
    const sessionId = typeof request.sessionId === "string" ? request.sessionId : "";
    const toolCall = request.toolCall ?? {};
    const title = typeof toolCall.title === "string" ? toolCall.title : "tool call";
    const options = Array.isArray(request.options) ? request.options : [];
    const kinds = options.map((option) => option && typeof option === "object" ? String(option.kind ?? "") : "");
    const decision = this.options.onPermission?.({ sessionId, title, options: kinds }) ?? "deny";
    const wanted = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const index = kinds.findIndex((kind) => wanted.includes(kind));
    const chosen = index >= 0 ? options[index] : void 0;
    const optionId = typeof chosen?.optionId === "string" ? chosen.optionId : void 0;
    this.write({
      jsonrpc: "2.0",
      id,
      result: optionId === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } }
    });
  }
  notification(method, params) {
    if (method !== "session/update") return;
    const request = params ?? {};
    if (typeof request.sessionId !== "string" || !request.update || typeof request.update !== "object") return;
    this.options.onUpdate?.({ sessionId: request.sessionId, update: request.update });
  }
};

// src/headless.ts
var MAX_ANSWER = 2e5;
var MAX_RAW = 1e6;
function brief2(value, limit = 160) {
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
        const input = brief2(event.input);
        return [{ kind: "log", text: `
\u25B8 ${tool}${input && input !== "{}" ? ` ${input}` : ""}
` }];
      }
      case "tool_result": {
        if (event.status !== "error") return [];
        return [{ kind: "error", text: `
\u2717 ${brief2(event.result, 400)}
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
    const { signal, stdin, timeoutMs = 12e4, onOutput, env } = runOptions;
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
        ...env === void 0 ? {} : { env },
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

// src/secrets.ts
import { chmod as chmod2, mkdir as mkdir3, readFile as readFile3, rename as rename2, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname4 } from "node:path";
var MAX_SECRET = 4096;
function secretsPathFor(storeFile) {
  return storeFile.endsWith(".json") ? `${storeFile.slice(0, -5)}.secrets.json` : `${storeFile}.secrets.json`;
}
var SecretStore = class {
  constructor(file) {
    this.file = file;
  }
  file;
  chain = Promise.resolve();
  /** 读取全部密码；文件缺失视为空，结构损坏抛错。 / Read every password; a missing file is empty, a broken one throws. */
  async load() {
    let text;
    try {
      text = await readFile3(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return /* @__PURE__ */ new Map();
      throw new Error(`Cannot read the remote instance passwords: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The remote instance password file is not valid JSON; fix or delete it before retrying");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.passwords !== "object") {
      throw new Error("The remote instance password file has no `passwords` object");
    }
    const result = /* @__PURE__ */ new Map();
    for (const [name2, value] of Object.entries(parsed.passwords)) {
      if (typeof value === "string" && value.length > 0 && value.length <= MAX_SECRET) result.set(name2, value);
    }
    return result;
  }
  /** 读一个密码。 / Read one password. */
  async get(name2) {
    return (await this.load()).get(name2);
  }
  /** 写入或替换一个密码。 / Store or replace one password. */
  async set(name2, password) {
    await this.serialize(async () => {
      const passwords = await this.load();
      passwords.set(name2, assertSecret(password));
      await this.write(passwords);
    });
  }
  /** 删除一个密码；不存在时忽略。 / Remove one password; a missing name is ignored. */
  async delete(name2) {
    await this.serialize(async () => {
      const passwords = await this.load();
      if (passwords.delete(name2)) await this.write(passwords);
    });
  }
  async write(passwords) {
    await mkdir3(dirname4(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify({ version: 1, passwords: Object.fromEntries(passwords) }, null, 2) + "\n";
    await writeFile3(temporary, body, { encoding: "utf8", mode: 384 });
    await chmod2(temporary, 384);
    await rename2(temporary, this.file);
  }
  serialize(operation) {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => void 0);
    return next;
  }
};
function assertSecret(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("password must be a non-empty string");
  if (value.length > MAX_SECRET) throw new Error(`password is too long (max ${MAX_SECRET} characters)`);
  if (value.includes("\0")) throw new Error("password must not contain NUL characters");
  return value;
}

// src/service.ts
import { StringDecoder as StringDecoder2 } from "node:string_decoder";

// src/tool.ts
var ACTIONS = ["instances", "add", "remove", "probe", "ask", "jobs", "status", "cancel", "sessions", "new", "history", "send", "stop", "close"];
var READ_ACTIONS = /* @__PURE__ */ new Set(["instances", "probe", "jobs", "status", "sessions", "history"]);
var NATIVE_ACTIONS = /* @__PURE__ */ new Set(["add", "remove", "ask", "new", "send", "stop", "close"]);
var FIELDS = {
  action: {
    type: "string",
    enum: ACTIONS,
    description: "instances lists registered devices (plus this host\u2019s identity and each device\u2019s purpose note); add/remove edit the device list; probe checks ssh reachability, remote dsh version, profile directory, and platform; ask dispatches a one-shot task as a background job (jobs/status/cancel track it); sessions lists the remote DSH\u2019s own conversations via ACP; new opens one in a directory; history reads what has been said since this plugin opened it; send posts a message into one; stop cancels its running turn; close ends it."
  },
  name: { type: "string", description: "Device name from instances, e.g. laptop. Required by remove/probe/ask; `add` creates or replaces it and derives a name from the host when omitted." },
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
  password: { type: "string", description: "For add: the ssh password for this device. Stored in a 0600 file beside the device list and never returned; prefer the Settings panel, because a tool argument is recorded in the conversation log." },
  prompt: { type: "string", description: "For ask: the task text handed to the remote DSH agent. It travels over stdin, never inside a shell command line." },
  sessionId: { type: "string", description: "For ask: continue an existing remote dsh session id instead of starting a fresh one." },
  jobId: { type: "string", description: "For status/cancel: the jobId returned by ask or listed by jobs." },
  wait: { type: "boolean", description: "For send: wait for the remote turn to finish before returning (default true). The Settings panel and the session toolbar always poll instead." },
  refresh: { type: "boolean", description: "For history: read the remote session log again instead of using the cached copy." },
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
  "Each registered instance is a device running dsh on Linux, macOS, or Windows; ask hands one prompt to that device\u2019s DSH agent (dsh --profile <profile> --json) and streams its progress as an ordinary background job, so several instances and several tasks can run in parallel.",
  "instances lists devices, add/remove edit the list, probe checks ssh reachability plus remote dsh version and profile directory, ask starts a job, and jobs/status/cancel track or stop that job.",
  "The prompt is piped over stdin, so no task text reaches a remote shell command line. add/remove/ask are native operations and need Full Access or a one-shot user approval; read-only actions do not.",
  "Authentication is either a password (stored in a 0600 file beside the list, answered by SSH_ASKPASS, never placed in argv or a log) or a key from ssh config or an ssh-agent. A first-seen host key is accepted on the first connection and pinned; a changed key still fails."
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
function deriveInstanceName(host) {
  const base = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return base || "remote";
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
function probeUsable(facts) {
  const version = facts?.version;
  return typeof version === "string" && version.length > 0 && version !== "missing" && !/not found|not recognized|CommandNotFound/i.test(version);
}
var RemoteInstanceService = class {
  constructor(ctx, settings, overrides = {}) {
    this.ctx = ctx;
    this.settings = settings;
    this.store = overrides.store ?? new InstanceStore({ file: settings.storeFile });
    this.secrets = overrides.secrets ?? new SecretStore(secretsPathFor(settings.storeFile));
    this.runner = overrides.runner ?? createRunner(ctx.subprocess, { active: this.active });
    this.acpFactory = overrides.acp;
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
  secrets;
  runner;
  sealed = false;
  seeded = false;
  askpassDirectory;
  askpassPath;
  acpFactory;
  links = /* @__PURE__ */ new Map();
  transcripts = /* @__PURE__ */ new Map();
  logCache = /* @__PURE__ */ new Map();
  /** 设备清单文件路径。 / The device-list path. */
  get storeDisplayPath() {
    return displayPath(this.store.path);
  }
  /** 执行一个动作。`ui` 来源只允许清单与探测。 / Execute one action; the `ui` source may only manage the list and probe. */
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
      case "sessions":
        return this.remoteSessions(args);
      case "new":
        return this.newRemoteSession(args, options);
      case "history":
        return this.history(args);
      case "send":
        return this.sendMessage(args, options);
      case "stop":
        return this.stopSession(args);
      case "close":
        return this.closeSession(args);
      default:
        throw new Error("Unknown remote instance action");
    }
  }
  /** 已登记的设备及其最近探测结论。 / Registered devices with their last probe. */
  async list() {
    const snapshot = await this.load();
    const passwords = await this.secrets.load();
    const summaries = [...snapshot.instances.values()].sort((left, right) => left.name.localeCompare(right.name)).map((instance) => instanceSummary(this.withAuth(instance, passwords.has(instance.name))));
    return {
      store: this.storeDisplayPath,
      local: { hostname: hostname2(), platform: process.platform === "win32" ? "windows" : "posix" },
      instances: summaries,
      ...snapshot.skipped.length === 0 ? {} : { skipped: snapshot.skipped }
    };
  }
  /** 探测一台设备：认证方式由记录决定，平台未知时先试 POSIX 再试 Windows。 / Probe one device. */
  async probe(args, signal) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const started = Date.now();
    let platform = instance.platform ?? "posix";
    let facts;
    let stderr = "";
    let message;
    let ok = false;
    try {
      const first = await this.runProbe(instance, platform, signal);
      facts = first.facts;
      stderr = first.stderr;
      if (!probeUsable(facts)) {
        const other = platform === "posix" ? "windows" : "posix";
        const second = await this.runProbe(instance, other, signal);
        if (probeUsable(second.facts) || second.facts?.platform !== void 0) {
          facts = second.facts;
          stderr = second.stderr;
          platform = second.platform;
        }
      }
      platform = facts?.platform ?? platform;
      ok = probeUsable(facts);
      if (!ok) message = stderr || "the remote device reported no dsh version";
      else if (facts?.profile === "missing") message = `the remote device has no profile "${instance.profile}"; create it there or register another profile`;
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
    const stored = await this.recordProbe(instance, probe, platform);
    return {
      instance: instanceSummary(this.withAuth(stored, await this.hasPassword(stored.name))),
      ok,
      platform,
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
  /** 新增或替换一台设备；`password` 只写进密码文件。 / Add or replace one device; `password` only reaches the password file. */
  async add(args, options) {
    const host = typeof args.host === "string" ? args.host : "";
    const name2 = typeof args.name === "string" && args.name ? args.name : deriveInstanceName(host);
    const snapshot = await this.load();
    const existing = snapshot.instances.get(name2);
    await this.authorize(args, options);
    const password = args.password === void 0 ? void 0 : assertSecret(args.password);
    const auth = password !== void 0 ? "password" : existing?.auth ?? "key";
    const instance = validateInstance(
      {
        name: name2,
        host,
        user: args.user,
        port: args.port,
        identityFile: args.identityFile,
        proxyJump: args.proxyJump,
        profile: args.profile,
        dsh: args.dsh,
        shell: args.shell,
        cwd: args.cwd,
        note: args.note,
        auth,
        platform: existing?.platform
      },
      { existing }
    );
    if (password !== void 0) await this.secrets.set(instance.name, password);
    await this.store.update((instances) => {
      instances.set(instance.name, instance);
    });
    return { instance: instanceSummary(this.withAuth(instance, password !== void 0 || await this.hasPassword(instance.name))), replaced: existing !== void 0, auth };
  }
  /** 移除一台设备及其保存的密码。 / Remove one device and its stored password. */
  async remove(args, options) {
    const name2 = requireString(args.name, "name");
    await this.authorize(args, options);
    let existed = false;
    await this.store.update((instances) => {
      existed = instances.delete(name2);
    });
    await this.secrets.delete(name2);
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
    const platform = instance.platform ?? "posix";
    const command = taskCommand(instance, platform, sessionId);
    await this.authorize(args, options);
    if ((instance.auth ?? "key") === "password" && !await this.hasPassword(instance.name)) {
      throw new Error(`remote instance "${instance.name}" needs a password; re-add it with the password field`);
    }
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
            const result = await this.exec(instance, command, {
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
              platform,
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
            this.remember(job.id, { instance: instance.name, platform, status: killed ? "killed" : "failed", answer: "", error: message });
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
    return { jobId, instance: instance.name, status: "running", platform, ...sessionId === void 0 ? {} : { sessionId } };
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
  /** 停止全部在跑任务、清理 askpass 临时目录并等待进程退出。 / Stop live work and clean the askpass directory. */
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
    const links = [...this.links.values()];
    this.links.clear();
    await Promise.allSettled([...this.pending, ...[...this.active].map((child) => child.waitForExit())]);
    await Promise.allSettled(links.map(async (creation) => {
      try {
        const client = await creation;
        await client.dispose();
      } catch {
      }
    }));
    this.transcripts.clear();
    if (this.askpassDirectory !== void 0) await rm(this.askpassDirectory, { recursive: true, force: true });
    this.results.clear();
    this.ownedJobs.clear();
    this.contexts.clear();
  }
  /** 远端 DSH 自己的会话（ACP `session/list`）。 / The remote DSH's own conversations. */
  async remoteSessions(args) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : void 0;
    const client = await this.linkFor(instance);
    const sessions = await client.listSessions(cwd);
    return { instance: instance.name, ...cwd === void 0 ? {} : { cwd }, sessions };
  }
  /** 在远端目录里开一个新会话。 / Open a fresh conversation in a remote directory. */
  async newRemoteSession(args, options) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : instance.cwd;
    if (!cwd) throw new Error("cwd is required to open a remote session");
    await this.authorize(args, options);
    const client = await this.linkFor(instance);
    const sessionId = await client.newSession(cwd);
    this.transcriptFor(instance, sessionId, cwd);
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) return { instance: instance.name, sessionId, cwd, status: "idle" };
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too large (max ${MAX_PROMPT} characters)`);
    const wait = args.wait !== false;
    const turn = await this.runTurn(instance, client, sessionId, prompt, wait);
    return { instance: instance.name, sessionId, cwd, status: wait ? "completed" : "running", ...turn === void 0 ? {} : { stopReason: turn.stopReason } };
  }
  /**
   * 远端会话历史：优先读远端日志（zstd + JSONL v4）并解析，读不到时退回本插件打开后收到的消息。
   * Remote history: read and parse the remote zstd/JSONL log first, and fall back
   * to what this plugin has seen since it opened the session.
   */
  async history(args) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const sessionId = requireString(args.sessionId, "sessionId");
    const key = this.transcriptKey(instance.name, sessionId);
    const transcript = this.transcripts.get(key);
    const cached = this.logCache.get(key);
    const refresh = args.refresh === true || cached === void 0 || Date.now() - cached.at > 1e4;
    let parsed = cached?.parse;
    let source = parsed === void 0 ? "live" : "log";
    let note;
    if (refresh) {
      try {
        const base64 = await this.fetchSessionLog(instance, sessionId);
        if (base64) {
          parsed = parseSessionLog(decompressFrames(Buffer.from(base64, "base64")));
          this.logCache.set(key, { at: Date.now(), parse: parsed });
          source = "log";
        } else {
          note = "\u6CA1\u6709\u627E\u5230\u8FDC\u7AEF\u4F1A\u8BDD\u65E5\u5FD7\uFF1B\u8FD9\u91CC\u53EA\u6709\u672C\u63D2\u4EF6\u6253\u5F00\u8BE5\u4F1A\u8BDD\u4E4B\u540E\u6536\u5230\u7684\u6D88\u606F\u3002 / No remote session log was found; only messages seen since this plugin opened it are shown.";
        }
      } catch (error) {
        note = `\u8BFB\u53D6\u8FDC\u7AEF\u5386\u53F2\u5931\u8D25\uFF1A${safeMessage(error)}\u3002\u4EC5\u663E\u793A\u672C\u63D2\u4EF6\u6253\u5F00\u540E\u6536\u5230\u7684\u6D88\u606F\u3002 / Reading the remote history failed; only live messages are shown.`;
      }
    }
    const messages = source === "log" && parsed !== void 0 ? parsed.messages : transcript?.messages ?? [];
    return {
      instance: instance.name,
      sessionId,
      source,
      ...parsed?.cwd === void 0 ? {} : { cwd: parsed.cwd },
      ...transcript?.title === void 0 ? {} : { title: transcript.title },
      running: transcript?.running ?? false,
      ...transcript?.stopReason === void 0 ? {} : { stopReason: transcript.stopReason },
      messages,
      ...note === void 0 ? {} : { note }
    };
  }
  /** 读取远端会话日志的 base64；命令固定、只读。 / Read the remote session log as base64 with a fixed, read-only command. */
  async fetchSessionLog(instance, sessionId) {
    const platform = instance.platform ?? "posix";
    const raw = historyCommand(platform, void 0, sessionId);
    const command = platform === "windows" || instance.shell === "" ? raw : `${shellQuote(instance.shell)} -lc ${shellQuote(raw)}`;
    const result = await this.exec(instance, command, { signal: this.lifetime.signal, timeoutMs: 6e4 });
    return result.stdout.replace(/\s+/g, "");
  }
  /** 往远端会话里发一条消息。 / Post one message into a remote conversation. */
  async sendMessage(args, options) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const sessionId = requireString(args.sessionId, "sessionId");
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) throw new Error("prompt is required");
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too large (max ${MAX_PROMPT} characters)`);
    await this.authorize(args, options);
    const client = await this.linkFor(instance);
    const wait = args.wait !== false;
    const turn = await this.runTurn(instance, client, sessionId, prompt, wait);
    const transcript = this.transcriptFor(instance, sessionId);
    return {
      instance: instance.name,
      sessionId,
      status: wait ? "completed" : "running",
      ...turn === void 0 ? {} : { stopReason: turn.stopReason },
      messages: transcript.messages.slice(-6)
    };
  }
  /** 取消远端会话当前回合。 / Cancel the running turn of a remote conversation. */
  async stopSession(args) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const sessionId = requireString(args.sessionId, "sessionId");
    const client = await this.linkFor(instance);
    await client.cancel(sessionId);
    const transcript = this.transcripts.get(this.transcriptKey(instance.name, sessionId));
    if (transcript) transcript.running = false;
    return { instance: instance.name, sessionId, status: "cancelled" };
  }
  /** 关闭远端会话并丢弃本插件保存的对话。 / Close a remote conversation and drop what this plugin kept. */
  async closeSession(args) {
    const instance = await this.findInstance(requireString(args.name, "name"));
    const sessionId = requireString(args.sessionId, "sessionId");
    const client = await this.linkFor(instance);
    await client.closeSession(sessionId);
    this.transcripts.delete(this.transcriptKey(instance.name, sessionId));
    return { instance: instance.name, sessionId, status: "closed" };
  }
  /** 取得（或建立）一台设备的 ACP 连接；失败后下次调用会重连。 / Get or open the instance ACP link; a failure is retried next call. */
  async linkFor(instance) {
    const existing = this.links.get(instance.name);
    if (existing) return existing;
    const factory = this.acpFactory ?? ((target) => this.spawnAcp(target));
    const creation = factory(instance);
    this.links.set(instance.name, creation);
    void creation.catch(() => {
      if (this.links.get(instance.name) === creation) this.links.delete(instance.name);
    });
    return creation;
  }
  /** 用 ssh 拉起远端 `dsh --profile acp`。 / Start the remote `dsh --profile acp` over ssh. */
  async spawnAcp(instance) {
    const auth = instance.auth ?? "key";
    const argv = sshArgv(sshTargetOf(instance), acpCommand(instance, instance.platform ?? "posix"), { connectTimeoutMs: this.settings.connectTimeoutMs, auth });
    let env;
    if (auth === "password") {
      const password = await this.secrets.get(instance.name);
      if (password === void 0) throw new Error(`remote instance "${instance.name}" needs a password; re-add it with the password field`);
      env = { ...askpassEnv(await this.askpassHelper()), DSH_REMOTE_PASSWORD: password };
    }
    const child = this.ctx.subprocess.spawn({
      argv,
      cwd: process.cwd(),
      graceMs: 3e3,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ...env === void 0 ? {} : { env }
    });
    const stdin = child.stdin;
    if (!stdin) {
      child.terminate();
      throw new Error("the ssh client exposed no stdin for ACP");
    }
    this.active.add(child);
    void child.done.finally(() => this.active.delete(child)).catch(() => void 0);
    let stderr = "";
    void (async () => {
      try {
        for await (const chunk of child.stderr ?? []) stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-4e3);
      } catch {
      }
    })();
    let resolveClosed = () => void 0;
    const closed = new Promise((resolve) => {
      resolveClosed = () => resolve();
    });
    void child.done.then(() => resolveClosed(), () => resolveClosed());
    stdin.on("error", () => resolveClosed());
    let ended = false;
    const transport = {
      stdin: {
        write: (text) => {
          if (ended) throw new Error("the ACP stdin is closed");
          try {
            stdin.write(text);
          } catch (error) {
            ended = true;
            resolveClosed();
            throw error;
          }
        },
        end: () => {
          ended = true;
          try {
            stdin.end();
          } catch {
          }
        }
      },
      lines: linesOf(child.stdout),
      closed,
      terminate: () => {
        ended = true;
        child.terminate();
        resolveClosed();
      }
    };
    try {
      return await AcpClient.connect(transport, {
        requestTimeoutMs: 3e4,
        onUpdate: (event) => this.applyUpdate(instance, event),
        // 远端 ACP 没有别的审批来源；一次性允许并写进对话，用户能在面板里看到。 / ACP has no other approval source; allow once and record it in the transcript.
        onPermission: (request) => {
          const transcript = this.transcriptFor(instance, request.sessionId);
          transcript.messages.push({ role: "notice", text: `\u5DF2\u81EA\u52A8\u5141\u8BB8\u8FDC\u7AEF\u5DE5\u5177\uFF1A${request.title}`, at: Date.now() });
          return "allow";
        },
        onWarning: (message) => this.ctx.logger?.warn(`remote-instance ${instance.name}: ${message}${stderr ? ` (${stderr.slice(-400)})` : ""}`)
      });
    } catch (error) {
      child.terminate();
      this.active.delete(child);
      throw new Error(`cannot open the ACP link to ${instance.name}: ${safeMessage(error)}${stderr ? ` (${stderr.slice(-600)})` : ""}`);
    }
  }
  transcriptKey(instance, sessionId) {
    return `${instance}\0${sessionId}`;
  }
  transcriptFor(instance, sessionId, cwd) {
    const key = this.transcriptKey(instance.name, sessionId);
    const existing = this.transcripts.get(key);
    if (existing) return existing;
    const created = { instance: instance.name, sessionId, cwd: cwd ?? instance.cwd ?? "", running: false, messages: [] };
    this.transcripts.set(key, created);
    return created;
  }
  /** 把 ACP 更新折叠成交互记录。 / Fold one ACP update into the transcript. */
  applyUpdate(instance, event) {
    const kind = typeof event.update.sessionUpdate === "string" ? event.update.sessionUpdate : "";
    if (!kind) return;
    const transcript = this.transcriptFor(instance, event.sessionId);
    const contentText = (value) => {
      if (!value || typeof value !== "object") return "";
      const text = value.text;
      return typeof text === "string" ? text : "";
    };
    const append = (role, text, extra = {}) => {
      if (!text) return;
      const last = transcript.messages[transcript.messages.length - 1];
      if (last && last.role === role && last.id === void 0 && extra.id === void 0 && role !== "tool") {
        transcript.messages[transcript.messages.length - 1] = { ...last, text: (last.text + text).slice(-2e5) };
        return;
      }
      transcript.messages.push({ role, text: text.slice(0, 2e5), at: Date.now(), ...extra.id === void 0 ? {} : { id: extra.id }, ...extra.status === void 0 ? {} : { status: extra.status } });
      if (transcript.messages.length > 240) transcript.messages.splice(0, 40);
    };
    switch (kind) {
      case "agent_message_chunk":
        append("assistant", contentText(event.update.content));
        break;
      case "agent_thought_chunk":
        append("thought", contentText(event.update.content));
        break;
      case "tool_call": {
        const id = typeof event.update.toolCallId === "string" ? event.update.toolCallId : void 0;
        const title = typeof event.update.title === "string" ? event.update.title : "tool";
        append("tool", title, { ...id === void 0 ? {} : { id }, ...typeof event.update.status === "string" ? { status: event.update.status } : {} });
        break;
      }
      case "tool_call_update": {
        const id = typeof event.update.toolCallId === "string" ? event.update.toolCallId : void 0;
        if (id === void 0) break;
        for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
          const message = transcript.messages[index];
          if (!message || message.id !== id) continue;
          transcript.messages[index] = { ...message, ...typeof event.update.status === "string" ? { status: event.update.status } : {} };
          break;
        }
        break;
      }
      case "session_info_update":
        if (typeof event.update.title === "string" && event.update.title) transcript.title = event.update.title;
        break;
      default:
        break;
    }
  }
  /** 发一轮对话；`wait` 为 false 时只保证已提交。 / Run one turn; without `wait` it only confirms submission. */
  async runTurn(instance, client, sessionId, prompt, wait) {
    const transcript = this.transcriptFor(instance, sessionId);
    transcript.messages.push({ role: "user", text: prompt, at: Date.now() });
    transcript.running = true;
    const turn = client.prompt(sessionId, prompt).then((result) => {
      transcript.stopReason = result.stopReason;
      return result;
    }).catch((error) => {
      transcript.messages.push({ role: "notice", text: safeMessage(error), at: Date.now() });
      throw error;
    }).finally(() => {
      transcript.running = false;
    });
    if (!wait) {
      void turn.catch(() => void 0);
      return void 0;
    }
    return turn;
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
  withAuth(instance, hasPassword) {
    const auth = instance.auth ?? (hasPassword ? "password" : "key");
    return { ...instance, auth };
  }
  async hasPassword(name2) {
    return await this.secrets.get(name2) !== void 0;
  }
  async recordProbe(instance, probe, platform) {
    const updated = { ...instance, lastProbe: probe, platform };
    await this.store.update((instances) => {
      if (instances.has(instance.name)) instances.set(instance.name, updated);
    });
    return updated;
  }
  /** 用实例自己的认证方式跑一次探测。 / Run one probe with the instance's own authentication. */
  async runProbe(instance, platform, signal) {
    const result = await this.exec(instance, probeCommand(instance, platform), {
      signal,
      timeoutMs: this.settings.probeTimeoutMs
    });
    const facts = parseProbeOutput(result.stdout);
    return { facts, stderr: result.stderr.trim().slice(-4e3), platform: facts.platform ?? platform };
  }
  /** 统一执行：按认证方式注入 askpass，密码只出现在环境里。 / Every run: askpass is injected per authentication mode, password only in the environment. */
  async exec(instance, command, options) {
    const auth = instance.auth ?? "key";
    const argv = sshArgv(sshTargetOf(instance), command, { connectTimeoutMs: this.settings.connectTimeoutMs, auth });
    let env;
    if (auth === "password") {
      const password = await this.secrets.get(instance.name);
      if (password === void 0) throw new Error(`remote instance "${instance.name}" needs a password; re-add it with the password field`);
      env = { ...askpassEnv(await this.askpassHelper()), DSH_REMOTE_PASSWORD: password };
    }
    return this.runner(argv, { ...options, ...env === void 0 ? {} : { env } });
  }
  /** 惰性创建 0700 的 askpass 助手；Windows 宿主没有可用的 askpass。 / Lazily create the 0700 askpass helper. */
  async askpassHelper() {
    if (process.platform === "win32") throw new Error("password authentication needs a POSIX ssh client; on a Windows host use a key instead");
    if (this.askpassPath !== void 0) return this.askpassPath;
    const directory = await mkdtemp(join3(tmpdir(), "dsh-ri-askpass-"));
    await chmod3(directory, 448);
    const file = join3(directory, "askpass.sh");
    await writeFile4(file, ASKPASS_SCRIPT, { mode: 448 });
    await chmod3(file, 448);
    this.askpassDirectory = directory;
    this.askpassPath = file;
    return file;
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
async function* linesOf(stream) {
  if (!stream) return;
  const decoder = new StringDecoder2("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.write(Buffer.from(chunk));
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  if (buffer) yield buffer;
}

// src/host.ts
var name = "remote-instance";
var inject = ["tools", "subprocess", "jobs", "sandboxPolicy", "approval", "agents", "webServer", "connection"];
var TOOL_NAME = "remote_instance";
function apply(ctx, config) {
  const settings = resolveSettings(config);
  const service = new RemoteInstanceService(ctx, settings);
  ctx.effect(() => () => service.dispose(), "remote-instance.dispose");
  if (settings.bridgePort > 0) {
    void startBridge(
      { get: (name2) => ctx.get?.(name2), ...ctx.logger === void 0 ? {} : { logger: ctx.logger } },
      { port: settings.bridgePort, tokenFile: settings.bridgeTokenFile, dshHome: dirname5(settings.storeFile) }
    ).then((bridge) => {
      ctx.effect(() => () => bridge.close(), "remote-instance.bridge");
    }, (error) => {
      ctx.logger?.warn(`remote-instance bridge failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
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
  ASKPASS_SCRIPT,
  AcpClient,
  AcpConnectionError,
  InstanceStore,
  MAX_LOG_BYTES,
  NAME_PATTERN,
  OBSERVE_PATH,
  READ_ACTIONS,
  RemoteInstanceService,
  SecretStore,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  apply,
  askpassEnv,
  assertSecret,
  createActionHandler,
  createObserveHandler,
  createRunner,
  createTaskParser,
  decompressFrames,
  displayPath,
  displayTarget,
  encodePowerShell,
  historyCommand,
  inject,
  instanceSummary,
  name,
  parseProbeOutput,
  parseSessionLog,
  posixProbeCommand,
  posixTaskCommand,
  powershellCommand,
  probeCommand,
  psQuote,
  posixProbeCommand as remoteProbeCommand,
  posixTaskCommand as remoteTaskCommand,
  resolveDshHome,
  resolveSettings,
  restoreInstance,
  sameLoopbackOrigin,
  secretsPathFor,
  shellQuote,
  sshArgv,
  startBridge,
  taskCommand,
  validateInstance,
  validateRequest,
  windowsProbeCommand,
  windowsTaskCommand
};
