import net from "node:net";
import { WebSocketServer } from "ws";
import type { RawData } from "ws";

type Telemetry = {
  ts: number;
  temperatureC: number;
  humidityPct: number;
  co2ppm: number;
};

type AiAgentConfig = {
  enabled: boolean;
  autoEnabled: boolean;
  cropName: string;
  basePrompt: string;
  host: string;
  port: number;
  model: string;
  decisionIntervalMs: number;
};

type ActuatorDevice = {
  id: string;
  name: string;
  kind: "toggle" | "trigger";
  on?: string;
  off?: string;
  fire?: string;
};

const ACTUATOR_DEVICES: ActuatorDevice[] = [
  {
    id: "exhaustFan",
    name: "换气扇",
    kind: "toggle",
    on: "CC100300A200010400000000AAA9C0C3",
    off: "CC100300A200010400000000AAA80103"
  },
  {
    id: "growLight",
    name: "植物生长灯",
    kind: "toggle",
    on: "CC100300A200010400000000AA9A80D6",
    off: "CC100300A200010400000000AA8A811A"
  },
  {
    id: "humidifier",
    name: "加湿器",
    kind: "toggle",
    on: "CC100300A200010400000000AAA680C7",
    off: "CC100300A200010400000000AAA28104"
  },
  {
    id: "heater",
    name: "加热器",
    kind: "toggle",
    on: "CC100300A200010400000000AA6A8092",
    off: "CC100300A200010400000000AA2A8162"
  },
  {
    id: "curtain",
    name: "智能窗帘",
    kind: "toggle",
    on: "CC100300A2000104000000001AAAF502",
    off: "CC100300A2000104000000004AAAC902"
  },
  {
    id: "pump",
    name: "水泵控制",
    kind: "toggle",
    on: "CC100300A200010400000000A9AA8032",
    off: "CC100300A200010400000000A8AA81A2"
  },
  {
    id: "alarmLight",
    name: "报警灯",
    kind: "trigger",
    fire: "CC100300A200010400000000A2AA8702"
  }
];

const ACTUATOR_HEX_TO_STATE: Record<string, { id: string; value: boolean }> = {};

for (const dev of ACTUATOR_DEVICES) {
  if (dev.kind === "toggle") {
    if (dev.on) {
      ACTUATOR_HEX_TO_STATE[dev.on.replace(/[^0-9a-fA-F]/g, "").toUpperCase()] = { id: dev.id, value: true };
    }
    if (dev.off) {
      ACTUATOR_HEX_TO_STATE[dev.off.replace(/[^0-9a-fA-F]/g, "").toUpperCase()] = { id: dev.id, value: false };
    }
  } else if (dev.kind === "trigger" && dev.fire) {
    ACTUATOR_HEX_TO_STATE[dev.fire.replace(/[^0-9a-fA-F]/g, "").toUpperCase()] = { id: dev.id, value: true };
  }
}

const defaultAiPrompt =
  "你是一名现代数字温室的环境控制专家,需要根据当前作物和传感器数据,为温室中的执行设备给出控制建议,目标是在保证作物安全的前提下,尽量将环境维持在适宜范围。请避免频繁开关,避免在需要升温时长时间开启换气扇,检测到烟雾时优先保障安全并触发报警。你只负责根据当前一次的数据给出本次控制指令,不做长篇解释。";

let aiConfig: AiAgentConfig = {
  enabled: false,
  autoEnabled: true,
  cropName: "",
  basePrompt: defaultAiPrompt,
  host: process.env.AI_HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.AI_PORT ?? "11434", 10) || 11434,
  model: process.env.AI_MODEL ?? "gemma3:4b",
  decisionIntervalMs: 8000
};

let lastTelemetry: Telemetry | null = null;
let lastAiDecisionTs = 0;
let aiBusy = false;
const actuatorStates: Record<string, boolean> = {};

for (const dev of ACTUATOR_DEVICES) {
  actuatorStates[dev.id] = false;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createTelemetry(): Telemetry {
  return {
    ts: Date.now(),
    temperatureC: Number(randomBetween(18, 32).toFixed(2)),
    humidityPct: Number(randomBetween(35, 85).toFixed(2)),
    co2ppm: Math.round(randomBetween(420, 1400))
  };
}

function buildAiPrompt(telemetry: Telemetry): string {
  const lines: string[] = [];
  lines.push(aiConfig.basePrompt || defaultAiPrompt);
  lines.push("");
  lines.push(`当前作物: ${aiConfig.cropName || "未指定"}`);
  lines.push("当前环境传感器数据:");
  lines.push(`- 空气温度(°C): ${telemetry.temperatureC.toFixed(1)}`);
  lines.push(`- 空气湿度(%RH): ${telemetry.humidityPct.toFixed(1)}`);
  lines.push(`- CO₂(ppm): ${telemetry.co2ppm.toFixed(0)}`);
  lines.push("");
  lines.push("可控执行器列表,键为 id,值为布尔值(true=打开,false=关闭):");
  lines.push("- exhaustFan: 换气扇");
  lines.push("- growLight: 植物生长灯");
  lines.push("- humidifier: 加湿器");
  lines.push("- heater: 加热器");
  lines.push("- curtain: 智能窗帘");
  lines.push("- pump: 水泵控制");
  lines.push("- alarmLight: 报警灯(触发型,仅在需要时设为 true)");
  lines.push("");
  lines.push("请只输出一个严格合法的 JSON 对象,包含以下内容:");
  lines.push("- 每个执行器 id 对应的布尔值(true=打开,false=关闭)");
  lines.push('- 一个字符串字段 "reason", 简要说明本次控制的原因');
  lines.push(
    '例如: {"exhaustFan": true, "growLight": false, "humidifier": false, "heater": false, "curtain": false, "pump": false, "alarmLight": false, "reason": "因为温度偏高,需要打开换气扇散热"}'
  );
  lines.push("不要在 JSON 外输出任何其他文字,不要使用代码块标记。");
  return lines.join("\n");
}

function makeActuatorFrame(deviceId: string, value: boolean): Uint8Array | null {
  const device = ACTUATOR_DEVICES.find((d) => d.id === deviceId);
  if (!device) return null;
  let hex: string | undefined;
  if (device.kind === "trigger") {
    if (!value) return null;
    hex = device.fire;
  } else {
    hex = value ? device.on : device.off;
  }
  if (!hex) return null;
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length !== 32) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    const part = clean.slice(i * 2, i * 2 + 2);
    const n = Number.parseInt(part, 16);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function applyActuatorStatePatch(patch: Record<string, boolean>): void {
  let changed = false;
  for (const [id, value] of Object.entries(patch)) {
    if (actuatorStates[id] !== value) {
      actuatorStates[id] = value;
      changed = true;
    }
  }
  if (!changed) return;
  const msg = JSON.stringify({
    type: "actuatorStates",
    payload: {
      states: actuatorStates
    }
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

function applyAiDecision(
  decision: Record<string, unknown>,
  currentUpstream: net.Socket | null,
  currentState: "disconnected" | "connecting" | "connected"
): void {
  if (!currentUpstream) return;
  if (currentState !== "connected") return;
  const entries = Object.entries(decision);
  if (!entries.length) return;
  const patch: Record<string, boolean> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== "boolean") continue;
    patch[key] = raw;
    const frame = makeActuatorFrame(key, raw);
    if (!frame) continue;
    const buf = Buffer.from(frame);
    currentUpstream.write(buf.toString("hex").toUpperCase());
  }
  if (Object.keys(patch).length) {
    applyActuatorStatePatch(patch);
  }
}

async function maybeRunAi(
  telemetry: Telemetry,
  currentUpstream: net.Socket | null,
  currentState: "disconnected" | "connecting" | "connected",
  force: boolean
): Promise<void> {
  if (!aiConfig.enabled) return;
  const now = Date.now();
  if (aiBusy) return;
  if (!force) {
    if (!aiConfig.autoEnabled) return;
    if (now - lastAiDecisionTs < aiConfig.decisionIntervalMs) return;
  }
  aiBusy = true;
  try {
    const prompt = buildAiPrompt(telemetry);
    const url = `http://${aiConfig.host}:${aiConfig.port}/api/generate`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: aiConfig.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3
        }
      })
    });
    if (!res.ok) {
      console.log(`AI request failed: ${res.status} ${res.statusText}`);
      return;
    }
    const data = (await res.json()) as { response?: string };
    const text = typeof data.response === "string" ? data.response : "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return;
    const jsonText = text.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const decision = parsed as Record<string, unknown>;
    applyAiDecision(decision, currentUpstream, currentState);
    const msg = JSON.stringify({
      type: "aiDecision",
      payload: {
        ts: Date.now(),
        telemetry,
        decision
      }
    });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
    lastAiDecisionTs = now;
  } catch (e) {
    const err = e as Error;
    console.log(`AI request error: ${err.message}`);
  } finally {
    aiBusy = false;
  }
}

const port = Number(process.env.PORT ?? "8080");
const wss = new WebSocketServer({ port });

const upstreamHost = process.env.UPSTREAM_HOST ?? "127.0.0.1";
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? "2012");

let upstream: net.Socket | null = null;
let upstreamState: "disconnected" | "connecting" | "connected" = "disconnected";
let upstreamHexBuffer = "";

function broadcastBinary(data: Uint8Array): void {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

function tryExtractFrames(): void {
  const s = upstreamHexBuffer.toUpperCase();

  let idx = -1;
  for (let i = 0; i <= s.length - 4; i += 1) {
    if (i % 2 !== 0) continue;
    const h = s.slice(i, i + 4);
    if (h === "BB10" || h === "CC10") {
      idx = i;
      break;
    }
  }

  if (idx < 0) {
    upstreamHexBuffer = upstreamHexBuffer.slice(Math.max(0, upstreamHexBuffer.length - 3));
    return;
  }

  if (idx > 0) upstreamHexBuffer = upstreamHexBuffer.slice(idx);

  while (upstreamHexBuffer.length >= 32) {
    const frameHex = upstreamHexBuffer.slice(0, 32);
    upstreamHexBuffer = upstreamHexBuffer.slice(32);

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      const part = frameHex.slice(i * 2, i * 2 + 2);
      const n = Number.parseInt(part, 16);
      if (!Number.isFinite(n)) return;
      bytes[i] = n;
    }
    broadcastBinary(bytes);

    const next = upstreamHexBuffer.toUpperCase();
    if (next.length < 4) return;
    if (next.startsWith("BB10") || next.startsWith("CC10")) continue;
    tryExtractFrames();
    return;
  }
}

function connectUpstream(): void {
  if (upstreamState === "connecting" || upstreamState === "connected") return;
  upstreamState = "connecting";
  upstreamHexBuffer = "";

  const socket = new net.Socket();
  upstream = socket;

  socket.connect(upstreamPort, upstreamHost);

  socket.on("connect", () => {
    upstreamState = "connected";
    console.log(`tcp upstream connected: ${upstreamHost}:${upstreamPort}`);
  });

  socket.on("data", (data) => {
    const chunk = data.toString("utf8").replace(/[^0-9a-fA-F]/g, "");
    if (!chunk) return;
    upstreamHexBuffer += chunk;
    tryExtractFrames();
  });

  let reconnectScheduled = false;
  const scheduleReconnect = () => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    if (upstream === socket) upstream = null;
    if (upstreamState !== "disconnected") upstreamState = "disconnected";
    setTimeout(connectUpstream, 1000);
  };

  socket.on("error", (err) => {
    console.log(`tcp upstream error: ${String(err.message ?? err)}`);
    socket.destroy();
    scheduleReconnect();
  });

  socket.on("close", () => {
    console.log("tcp upstream closed");
    scheduleReconnect();
  });
}

const intervalMs = 1000;
const timer = setInterval(() => {
  const payload = createTelemetry();
  lastTelemetry = payload;
  const msg = JSON.stringify({ type: "telemetry", payload });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
  void maybeRunAi(payload, upstream, upstreamState, false);
}, intervalMs);

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "welcome", payload: { ts: Date.now() } }));
  ws.send(JSON.stringify({ type: "upstream", payload: { host: upstreamHost, port: upstreamPort, state: upstreamState, ts: Date.now() } }));
  ws.send(
    JSON.stringify({
      type: "actuatorStates",
      payload: {
        states: actuatorStates
      }
    })
  );

  ws.on("message", (data: RawData, isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    if (!isBinary) {
      const text = buf.toString("utf-8");
      if (text.length > 1024 * 32) return;
      try {
        const msg = JSON.parse(text) as { type?: string; payload?: unknown };
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", payload: { ts: Date.now() } }));
          return;
        }
        if (msg.type === "aiDecisionOnce") {
          const telemetry = lastTelemetry ?? createTelemetry();
          void maybeRunAi(telemetry, upstream, upstreamState, true);
          ws.send(
            JSON.stringify({
              type: "aiDecisionOnceAck",
              payload: { ok: true }
            })
          );
          return;
        }
        if (msg.type === "aiConfigUpdate") {
          const payload = msg.payload as Partial<AiAgentConfig> & {
            enabled?: boolean;
            autoEnabled?: boolean;
            cropName?: string;
            basePrompt?: string;
            host?: string;
            port?: number;
            model?: string;
            decisionIntervalMs?: number;
          };
          const next: AiAgentConfig = {
            enabled: typeof payload.enabled === "boolean" ? payload.enabled : aiConfig.enabled,
            autoEnabled: typeof payload.autoEnabled === "boolean" ? payload.autoEnabled : aiConfig.autoEnabled,
            cropName: typeof payload.cropName === "string" ? payload.cropName : aiConfig.cropName,
            basePrompt:
              typeof payload.basePrompt === "string" && payload.basePrompt.trim() ? payload.basePrompt : aiConfig.basePrompt,
            host: typeof payload.host === "string" && payload.host ? payload.host : aiConfig.host,
            port:
              typeof payload.port === "number" && Number.isFinite(payload.port) && payload.port > 0
                ? payload.port
                : aiConfig.port,
            model: typeof payload.model === "string" && payload.model ? payload.model : aiConfig.model,
            decisionIntervalMs:
              typeof payload.decisionIntervalMs === "number" && Number.isFinite(payload.decisionIntervalMs)
                ? Math.max(2000, payload.decisionIntervalMs)
                : aiConfig.decisionIntervalMs
          };
          aiConfig = next;
          ws.send(
            JSON.stringify({
              type: "aiConfigAck",
              payload: {
                ok: true
              }
            })
          );
          return;
        }
      } catch {
        return;
      }
      return;
    }

    if (buf.length === 16) {
      const hex = buf.toString("hex").toUpperCase();
      const mapped = ACTUATOR_HEX_TO_STATE[hex];
      if (mapped) {
        applyActuatorStatePatch({ [mapped.id]: mapped.value });
      }
      if (upstream && upstreamState === "connected") {
        upstream.write(hex);
      }
    }
    return;
  });
});

process.on("SIGINT", () => {
  upstream?.destroy();
  upstream = null;
  clearInterval(timer);
  wss.close();
  process.exit(0);
});

connectUpstream();
console.log(`ws server listening on ws://localhost:${port}`);
