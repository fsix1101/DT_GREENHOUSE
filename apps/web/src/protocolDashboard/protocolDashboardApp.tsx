import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Link, Link2Off, RefreshCw, Wifi, AlertTriangle, Moon, Sun, Home } from "lucide-react";
import { packFrame, unpackFrame, createPayload, decodeFrameValue, getSubType } from "../protocol/frame.ts";
import { Command, DataType, Head, type Bytes } from "../protocol/types.ts";
import { ACTUATOR_DEVICES, SENSOR_DEVICES } from "./constants.ts";
import { DeviceCard } from "./components/deviceCard.tsx";
import { HexMonitor, type LogEntry } from "./components/hexMonitor.tsx";

const DEFAULT_AI_PROMPT =
  "你是一名现代数字温室的环境控制助手,会根据作物信息和环境传感器数据,为换气扇、加热器、加湿器、植物生长灯、窗帘、水泵和报警灯给出控制建议,目标是在保证安全的前提下尽量接近适宜生长环境,避免频繁开关和互相矛盾的指令。";

type AiDecisionEntry = {
  id: string;
  ts: number;
  cropName: string;
  telemetry: {
    temperatureC: number;
    humidityPct: number;
    co2ppm: number;
  };
  decisions: Record<string, boolean>;
  reason?: string;
};

export function ProtocolDashboardApp(): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const autoRefreshIntervalRef = useRef<number | null>(null);
  const [logRefresh, setLogRefresh] = useState(true);
  const [target, setTarget] = useState<string>("-");

  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiCrop, setAiCrop] = useState("番茄");
  const [aiHost, setAiHost] = useState("127.0.0.1");
  const [aiPort, setAiPort] = useState(11434);
  const [aiModel, setAiModel] = useState("gemma3:4b");
  const [aiPrompt, setAiPrompt] = useState(DEFAULT_AI_PROMPT);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSaving, setAiSaving] = useState(false);

  const [aiAutoEnabled, setAiAutoEnabled] = useState(true);
  const [aiIntervalSec, setAiIntervalSec] = useState(8);

  const [aiDecisions, setAiDecisions] = useState<AiDecisionEntry[]>([]);

  const [deviceStates, setDeviceStates] = useState<Record<string, string | number | boolean>>({
    airTemp: 0,
    airHumi: 0,
    rainSnow: false,
    light: 0,
    pir: false,
    soilTemp: 0,
    soilHumi: 0,
    co2: 0,
    ph: 0,
    windSpeed: 0,
    windDir: 0,
    smoke: false,

    exhaustFan: false,
    growLight: false,
    humidifier: false,
    heater: false,
    curtain: false,
    pump: false,
    alarmLight: false
  });

  const addLog = useCallback(
    (type: "TX" | "RX", data: Bytes, crcOk?: boolean) => {
      if (!logRefresh) return;
      const newLog: LogEntry = {
        id: Math.random().toString(36).slice(2),
        timestamp: new Date().toLocaleTimeString("en-US", { hour12: false, minute: "2-digit", second: "2-digit" }),
        type,
        data,
        crcOk
      };
      setLogs((prev) => [newLog, ...prev].slice(0, 100));
    },
    [logRefresh]
  );

  const connect = useCallback(() => {
    socketRef.current?.close();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);

    const isSecure = window.location.protocol === "https:";
    const protocol = isSecure ? "wss" : "ws";
    const host = window.location.hostname || "localhost";
    const socketUrl = `${protocol}://${host}:8080`;
    setTarget(socketUrl);

    setConnectionError(null);

    try {
      const socket = new WebSocket(socketUrl);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        setIsConnected(true);
        setConnectionError(null);
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const text = event.data;
          if (!text) return;
          if (text.length > 1024 * 64) return;
          try {
            const msg = JSON.parse(text) as { type?: string; payload?: unknown };
            if (msg.type === "aiDecision") {
              const payload = msg.payload as {
                ts?: number;
                telemetry?: { temperatureC?: number; humidityPct?: number; co2ppm?: number };
                decision?: Record<string, unknown>;
              };
              const t = payload?.telemetry ?? {};
              const telemetry = {
                temperatureC: typeof t.temperatureC === "number" ? t.temperatureC : Number(deviceStates["airTemp"]) || 0,
                humidityPct: typeof t.humidityPct === "number" ? t.humidityPct : Number(deviceStates["airHumi"]) || 0,
                co2ppm: typeof t.co2ppm === "number" ? t.co2ppm : Number(deviceStates["co2"]) || 0
              };
              const decisionRaw = payload?.decision ?? {};
              const decisions: Record<string, boolean> = {};
              let reason: string | undefined;
              for (const [key, value] of Object.entries(decisionRaw)) {
                if (key === "reason" && typeof value === "string") {
                  reason = value;
                  continue;
                }
                if (typeof value === "boolean") {
                  decisions[key] = value;
                }
              }
              if (Object.keys(decisions).length) {
                setDeviceStates((prev) => {
                  const next: Record<string, string | number | boolean> = { ...prev };
                  for (const [id, val] of Object.entries(decisions)) {
                    if (id in next) {
                      next[id] = val;
                    }
                  }
                  return next;
                });
              }
              setAiDecisions((prev) => {
                const entry: AiDecisionEntry = {
                  id: Math.random().toString(36).slice(2),
                  ts: typeof payload?.ts === "number" ? payload.ts : Date.now(),
                  cropName: aiCrop,
                  telemetry,
                  decisions,
                  reason
                };
                return [entry, ...prev].slice(0, 50);
              });
              return;
            }
            if (msg.type === "actuatorStates") {
              const payload = msg.payload as {
                states?: Record<string, unknown>;
              };
              const ds = payload?.states ?? {};
              if (ds && typeof ds === "object") {
                const patch = ds as Record<string, unknown>;
                setDeviceStates((prev) => {
                  const next: Record<string, string | number | boolean> = { ...prev };
                  for (const [key, value] of Object.entries(patch)) {
                    if (key in next && typeof value === "boolean") {
                      next[key] = value;
                    }
                  }
                  return next;
                });
              }
              return;
            }
            if (msg.type === "aiConfigAck") {
              const payload = msg.payload as {
                ok?: boolean;
              };
              if (payload && payload.ok === false) {
                setAiError("应用 AI 配置失败");
                setAiSaving(false);
                return;
              }
              setAiSaving(false);
              setAiError(null);
              return;
            }
          } catch {
            return;
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const buffer: Bytes = new Uint8Array(event.data);
        const result = unpackFrame(buffer);
        addLog("RX", buffer, result?.crcOk);
        if (!result) return;
        if (!result.crcOk) return;

        const { frame } = result;
        const subType = getSubType(frame);
        const allDevices = [...SENSOR_DEVICES, ...ACTUATOR_DEVICES];
        const device = allDevices.find(
          (d) => d.mainType === frame.addr.mainType && d.subType === subType && (d.index === undefined || d.index === frame.addr.index)
        );
        if (!device) return;

        const value = decodeFrameValue(frame);
        if (value === null) return;
        setDeviceStates((prev) => ({ ...prev, [device.id]: value }));
      };

      socket.onclose = () => {
        setIsConnected(false);
        reconnectTimeoutRef.current = window.setTimeout(connect, 5000);
      };

      socket.onerror = () => {
        setConnectionError("Connection refused or server unreachable.");
      };

      socketRef.current = socket;
    } catch (e: unknown) {
      setIsConnected(false);
      const msg = e instanceof Error ? e.message : "The operation is insecure (SecurityError)";
      setConnectionError(msg);
      reconnectTimeoutRef.current = window.setTimeout(connect, 5000);
    }
  }, [addLog]);

  useEffect(() => {
    connect();
    return () => {
      socketRef.current?.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  const handleControl = (deviceId: string, value: boolean | number) => {
    const device = ACTUATOR_DEVICES.find((d) => d.id === deviceId);
    if (!device) return;

    const hexToFrame = (hex: string): Bytes | null => {
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
    };

    const hex =
      device.control.kind === "trigger"
        ? device.control.fire
        : typeof value === "boolean" && value
          ? device.control.on
          : device.control.off;

    const frame = hexToFrame(hex);
    if (!frame) return;

    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(frame.buffer);
    addLog("TX", frame);

    if (device.control.kind === "toggle") {
      setDeviceStates((prev) => ({ ...prev, [deviceId]: Boolean(value) }));
    } else {
      setDeviceStates((prev) => ({ ...prev, [deviceId]: false }));
    }
  };

  const manualQuery = useCallback(() => {
    for (const device of SENSOR_DEVICES) {
      const frame = packFrame({
        head: Head.PC_TO_NODE,
        addr: {
          mainType: device.mainType,
          subTypeHigh: (device.subType >> 8) & 0xff,
          subTypeLow: device.subType & 0xff,
          index: device.index ?? 0
        },
        cmd: Command.QUERY,
        dataType: DataType.BOOL,
        data: new Uint8Array(6)
      });
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(frame.buffer);
        addLog("TX", frame);
      }
    }
  }, [addLog]);

  useEffect(() => {
    if (autoRefresh) {
      manualQuery();
      autoRefreshIntervalRef.current = window.setInterval(manualQuery, 2000);
    } else {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    }
    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
      }
    };
  }, [autoRefresh, manualQuery]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const sendAiConfig = useCallback(() => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setAiError("WebSocket 未连接,无法发送配置");
      return;
    }
    setAiSaving(true);
    setAiError(null);
    const payload = {
      enabled: aiEnabled,
      autoEnabled: aiAutoEnabled,
      cropName: aiCrop.trim(),
      basePrompt: aiPrompt,
      host: aiHost.trim() || "127.0.0.1",
      port: Number(aiPort) || 11434,
      model: aiModel.trim() || "gemma3:4b",
      decisionIntervalMs: Math.max(2, aiIntervalSec) * 1000
    };
    try {
      socketRef.current.send(
        JSON.stringify({
          type: "aiConfigUpdate",
          payload
        })
      );
    } catch (e) {
      const err = e as Error;
      setAiError(err.message);
      setAiSaving(false);
    }
  }, [aiEnabled, aiAutoEnabled, aiIntervalSec, aiCrop, aiPrompt, aiHost, aiPort, aiModel]);

  const triggerAiOnce = useCallback(() => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setAiError("WebSocket 未连接,无法触发智能体决策");
      return;
    }
    if (!aiEnabled) {
      setAiError("请先启用 AI 控制");
      return;
    }
    setAiError(null);
    try {
      socketRef.current.send(
        JSON.stringify({
          type: "aiDecisionOnce",
          payload: {}
        })
      );
    } catch (e) {
      const err = e as Error;
      setAiError(err.message);
    }
  }, [aiEnabled]);

  return (
    <div className={`min-h-screen flex flex-col ${theme === "dark" ? "bg-slate-950 text-slate-50" : "bg-slate-50 text-slate-900"}`}>
      <header
        className={`px-6 py-4 sticky top-0 z-20 flex items-center justify-between border-b ${
          theme === "dark" ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200 shadow-sm"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white transition-colors duration-500 ${isConnected ? "bg-blue-600" : "bg-slate-400"}`}>
            <Activity size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">
              SmartNode Gateway <span className="text-blue-600">yoned.xyz</span>
            </h1>
            <div className="flex items-center gap-2 text-[10px] text-slate-400 font-semibold tracking-wider">
              <span className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-green-500 animate-blink" : "bg-red-500"}`}></div>
                {isConnected ? "SERVER CONNECTED" : "DISCONNECTED"}
              </span>
              <span>•</span>
              <span>UPSTREAM: yoned.xyz:2012 (TCP)</span>
              <span>•</span>
              <button onClick={connect} className="hover:text-blue-500 transition-colors flex items-center gap-1">
                <RefreshCw size={10} /> RECONNECT
              </button>
            </div>
          </div>
        </div>

        <nav className="hidden md:flex items-center gap-4">
          <button
            onClick={() => (window.location.hash = "#/viewer")}
            className={`transition-colors font-medium text-sm flex items-center gap-2 ${
              theme === "dark" ? "text-slate-200 hover:text-blue-400" : "text-slate-500 hover:text-blue-600"
            }`}
          >
            <Home size={18} /> Home
          </button>
          <button
            onClick={manualQuery}
            className={`transition-colors font-medium text-sm flex items-center gap-2 ${
              theme === "dark" ? "text-slate-200 hover:text-blue-400" : "text-slate-500 hover:text-blue-600"
            }`}
          >
            <RefreshCw size={18} /> Refresh All
          </button>
          {!isConnected && (
            <button
              onClick={connect}
              className={`transition-colors font-medium text-sm flex items-center gap-2 ${theme === "dark" ? "text-red-400 hover:text-red-300" : "text-red-500 hover:text-red-600"}`}
            >
              <Wifi size={18} /> Reconnect
            </button>
          )}
          <button
            onClick={toggleTheme}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 border transition-colors ${
              theme === "dark"
                ? "bg-slate-800 border-slate-700 text-slate-100 hover:bg-slate-700"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </button>
        </nav>


      </header>

      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        <div className="lg:col-span-8 flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
          <section>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Activity size={20} className="text-blue-600" /> Sensor Dashboard
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {SENSOR_DEVICES.map((device) => (
                <DeviceCard
                  key={device.id}
                  name={device.name}
                  icon={device.icon}
                  value={deviceStates[device.id] ?? "-"}
                  unit={device.unit}
                  theme={theme}
                  max={device.max}
                  hideProgress={device.hideProgress}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Wifi size={20} className="text-orange-500" /> Control Hub
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {ACTUATOR_DEVICES.map((device) => (
                <DeviceCard
                  key={device.id}
                  name={device.name}
                  icon={device.icon}
                  value={deviceStates[device.id] ?? "-"}
                  isActuator={true}
                  theme={theme}
                  onControl={(val) => handleControl(device.id, val)}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="lg:col-span-4 flex flex-col gap-6 h-[calc(100vh-8rem)]">
          <div className="flex flex-col h-full gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-widest flex items-center gap-2">
                <Link size={14} /> Traffic Log
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLogRefresh(!logRefresh)}
                  className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                    logRefresh ? "text-green-600 bg-green-50 border border-green-200" : "text-slate-400 bg-slate-100 border border-slate-200"
                  }`}
                >
                  {logRefresh ? "LIVE" : "PAUSED"}
                </button>
                <button onClick={() => setLogs([])} className="text-[10px] font-bold text-blue-600 hover:bg-blue-50 px-2 py-1 rounded transition-colors">
                  CLEAR
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              <HexMonitor logs={logs} />
            </div>

            <div
              className={`border rounded-xl p-4 flex flex-col gap-3 shadow-sm ${
                theme === "dark" ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"
              }`}
            >
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">AI Control</h3>
              <div className="space-y-3 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">启用 AI 控制</span>
                  <button
                    type="button"
                    onClick={() => setAiEnabled((v) => !v)}
                    className={`px-2 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                      aiEnabled
                        ? "bg-emerald-500 border-emerald-600 text-white"
                        : "bg-slate-100 border-slate-300 text-slate-500"
                    }`}
                  >
                    {aiEnabled ? "ENABLED" : "DISABLED"}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">自动决策</span>
                  <button
                    type="button"
                    onClick={() => setAiAutoEnabled((v) => !v)}
                    className={`px-2 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                      aiAutoEnabled
                        ? "bg-emerald-500 border-emerald-600 text-white"
                        : "bg-slate-100 border-slate-300 text-slate-500"
                    }`}
                  >
                    {aiAutoEnabled ? "AUTO ON" : "AUTO OFF"}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">作物</span>
                    <input
                      value={aiCrop}
                      onChange={(e) => setAiCrop(e.target.value)}
                      className={`px-2 py-1 rounded border text-[11px] ${
                        theme === "dark"
                          ? "bg-slate-900 border-slate-700 text-slate-50"
                          : "bg-white border-slate-200 text-slate-800"
                      }`}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">模型</span>
                    <input
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className={`px-2 py-1 rounded border text-[11px] ${
                        theme === "dark"
                          ? "bg-slate-900 border-slate-700 text-slate-50"
                          : "bg-white border-slate-200 text-slate-800"
                      }`}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-[2fr_1fr] gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Ollama Host</span>
                    <input
                      value={aiHost}
                      onChange={(e) => setAiHost(e.target.value)}
                      className={`px-2 py-1 rounded border text-[11px] ${
                        theme === "dark"
                          ? "bg-slate-900 border-slate-700 text-slate-50"
                          : "bg-white border-slate-200 text-slate-800"
                      }`}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">端口</span>
                    <input
                      type="number"
                      value={aiPort}
                      onChange={(e) => setAiPort(Number(e.target.value) || 0)}
                      className={`px-2 py-1 rounded border text-[11px] ${
                        theme === "dark"
                          ? "bg-slate-900 border-slate-700 text-slate-50"
                          : "bg-white border-slate-200 text-slate-800"
                      }`}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-[2fr_1fr] gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">自动决策间隔(秒)</span>
                    <input
                      type="number"
                      min={2}
                      value={aiIntervalSec}
                      onChange={(e) => setAiIntervalSec(Number(e.target.value) || 0)}
                      className={`px-2 py-1 rounded border text-[11px] ${
                        theme === "dark"
                          ? "bg-slate-900 border-slate-700 text-slate-50"
                          : "bg-white border-slate-200 text-slate-800"
                      }`}
                    />
                  </div>
                  <div className="flex flex-col gap-1 justify-end">
                    <button
                      type="button"
                      onClick={triggerAiOnce}
                      className="px-2 py-1 rounded text-[11px] font-semibold border border-emerald-500 text-emerald-600 hover:bg-emerald-50 transition-colors"
                    >
                      立即执行一次决策
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-slate-400">提示词</span>
                  <textarea
                    rows={4}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    className={`px-2 py-1 rounded border resize-none leading-snug ${
                      theme === "dark"
                        ? "bg-slate-900 border-slate-700 text-slate-50"
                        : "bg-white border-slate-200 text-slate-800"
                    }`}
                  />
                </div>
                {aiError && <div className="text-[10px] text-red-500">{aiError}</div>}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={sendAiConfig}
                    disabled={aiSaving}
                    className={`px-3 py-1.5 rounded text-[11px] font-semibold border transition-colors ${
                      aiSaving
                        ? "bg-slate-300 border-slate-400 text-slate-600 cursor-not-allowed"
                        : "bg-blue-600 border-blue-700 text-white hover:bg-blue-500"
                    }`}
                  >
                    {aiSaving ? "APPLYING..." : "应用配置"}
                  </button>
                </div>
              </div>
            </div>

            <div
              className={`border rounded-xl p-4 flex flex-col gap-3 shadow-sm ${
                theme === "dark" ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">AI Decisions</h3>
                {aiDecisions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAiDecisions([])}
                    className="text-[10px] font-bold text-blue-600 hover:bg-blue-50 px-2 py-1 rounded transition-colors"
                  >
                    CLEAR
                  </button>
                )}
              </div>
              <div className="space-y-2 text-[11px] max-h-64 overflow-y-auto custom-scrollbar">
                {aiDecisions.length === 0 ? (
                  <div className="text-slate-400">暂无智能体决策</div>
                ) : (
                  aiDecisions.map((entry) => {
                    const time = new Date(entry.ts).toLocaleTimeString("zh-CN", {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    });
                    const summaryParts: string[] = [];
                    for (const device of ACTUATOR_DEVICES) {
                      const v = entry.decisions[device.id];
                      if (typeof v === "boolean") {
                        summaryParts.push(`${device.name}:${v ? "开" : "关"}`);
                      }
                    }
                    const summary = summaryParts.join("，") || "本轮未调整执行器状态";
                    return (
                      <div key={entry.id} className="border border-slate-200 rounded-lg p-2.5 space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-slate-600">{time}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100">
                            作物: {aiCrop || entry.cropName || "未指定"}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
                          <span>温度: {entry.telemetry.temperatureC.toFixed(1)}°C</span>
                          <span>湿度: {entry.telemetry.humidityPct.toFixed(1)}%</span>
                          <span>CO₂: {entry.telemetry.co2ppm.toFixed(0)}ppm</span>
                        </div>
                        <div className="text-slate-600">控制: {summary}</div>
                        {entry.reason && (
                          <div className="text-slate-500 leading-snug">
                            原因: <span>{entry.reason}</span>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div
              className={`border rounded-xl p-4 flex flex-col gap-3 shadow-sm ${
                theme === "dark" ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"
              }`}
            >
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Diagnostic Info</h3>
              <div className="space-y-2 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-400">Gateway</span>
                  <code className="text-blue-600 font-bold">{target}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Local Port</span>
                  <code className={`font-bold ${theme === "dark" ? "text-slate-300" : "text-slate-700"}`}>8080</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Current Protocol</span>
                  <code className="text-purple-600 font-bold">{window.location.protocol === "https:" ? "WSS (Secure Required)" : "WS"}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">WebSocket Status</span>
                  <span className={isConnected ? "text-green-600 font-bold" : "text-red-500 font-bold"}>{isConnected ? "ESTABLISHED" : "FAILED/CLOSED"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="bg-slate-900 text-slate-400 px-6 py-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-widest">
        <div className="flex gap-4">
          <span className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full shadow-[0_0_8px] transition-colors ${isConnected ? "bg-green-500 shadow-green-500/60" : "bg-red-500 shadow-red-500/60"}`}></div>
            {isConnected ? "Synchronized" : "Offline"}
          </span>
          <span>Buffer: {logs.length} Frames</span>
        </div>
        <div>Industrial V1.1 • Gateway: {target}</div>
      </footer>
    </div>
  );
}
