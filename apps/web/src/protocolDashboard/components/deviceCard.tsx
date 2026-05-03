import React from "react";

type DeviceCardProps = {
  name: string;
  icon: string;
  value: string | number | boolean;
  unit?: string;
  isActuator?: boolean;
  onControl?: (val: boolean | number) => void;
  theme?: "light" | "dark";
  max?: number;
  hideProgress?: boolean;
};

export function DeviceCard({ name, icon, value, unit, isActuator, onControl, theme = "light", max = 100, hideProgress = false }: DeviceCardProps): React.JSX.Element {
  return (
    <div
      className={`p-4 rounded-xl border shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3 ${
        theme === "dark" ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200"
      }`}
    >
      <div className="flex justify-between items-start">
        <div
          className={`w-10 h-10 flex items-center justify-center rounded-lg text-2xl ${
            theme === "dark" ? "bg-slate-700" : "bg-slate-100"
          }`}
        >
          {icon}
        </div>
        {isActuator && (
          <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 tracking-tighter">
            <div className="w-1.5 h-1.5 rounded-full bg-slate-300"></div>
            ACTUATOR
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-600 truncate">{name}</h3>
        <div className="mt-1 flex items-baseline gap-1">
          {isActuator && typeof value === "boolean" ? (
            <button
              onClick={() => onControl?.(!value)}
              className={`w-full py-2 px-3 rounded-lg font-bold text-xs transition-all border ${
                value
                  ? "bg-blue-600 text-white border-blue-700 shadow-sm"
                  : theme === "dark"
                    ? "bg-slate-800 text-slate-100 border-slate-600 hover:bg-slate-700"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {value ? "ACTIVE" : "INACTIVE"}
            </button>
          ) : (
            <>
              <span
                className={`text-2xl font-bold tracking-tight ${
                  typeof value === "boolean"
                    ? value
                      ? "text-orange-500"
                      : "text-slate-400"
                    : theme === "dark"
                      ? "text-slate-50"
                      : "text-slate-800"
                }`}
              >
                {typeof value === "boolean" ? (value ? "ALERT" : "NORMAL") : value}
              </span>
              <span className="text-xs font-medium text-slate-400 uppercase">{unit}</span>
            </>
          )}
        </div>
      </div>

      {!isActuator && !hideProgress && typeof value === "number" && (
        <div className={`w-full rounded-full h-1.5 ${theme === "dark" ? "bg-slate-700" : "bg-slate-100"}`}>
          <div
            className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, (Number(value) / max) * 100))}%` }}
          ></div>
        </div>
      )}
    </div>
  );
}
