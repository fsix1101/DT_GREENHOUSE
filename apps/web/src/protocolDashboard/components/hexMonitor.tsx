import React from "react";
import { formatHex } from "../../protocol/frame.ts";
import type { Bytes } from "../../protocol/types.ts";

export type LogEntry = {
  id: string;
  timestamp: string;
  type: "TX" | "RX";
  data: Bytes;
  crcOk?: boolean;
};

type HexMonitorProps = {
  logs: LogEntry[];
};

export function HexMonitor({ logs }: HexMonitorProps): React.JSX.Element {
  return (
    <div className="bg-slate-900 text-green-400 p-4 rounded-lg font-mono text-xs overflow-hidden flex flex-col h-full border border-slate-700 shadow-xl">
      <div className="flex justify-between items-center mb-2 border-b border-slate-700 pb-2">
        <span className="font-bold text-slate-400">PROTOCOL MONITOR</span>
        <span className="text-[10px] text-slate-500">BAUD: 115200</span>
      </div>
      <div className="overflow-y-auto flex-1 space-y-1">
        {logs.length === 0 && <div className="text-slate-600 italic">No traffic detected...</div>}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2 hover:bg-slate-800 p-1 rounded transition-colors group">
            <span className="text-slate-500 min-w-[65px]">{log.timestamp}</span>
            <span className={log.type === "TX" ? "text-blue-400 font-bold" : "text-orange-400 font-bold"}>{log.type}</span>
            <span className="break-all tracking-wider group-hover:text-white">{formatHex(log.data)}</span>
            {log.crcOk === false && <span className="ml-auto text-red-400 font-bold">CRC</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
