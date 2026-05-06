from __future__ import annotations

import argparse
import asyncio
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

try:
    import numpy as np
    import skfuzzy as fuzz
    import skfuzzy.control as ctrl
except Exception as e:
    raise SystemExit(
        "Missing dependency: scikit-fuzzy/numpy. Install with uv, then re-run.\n"
        f"Import error: {e}"
    )

try:
    from gateway_api import GatewayWebSocketClient
except Exception:
    import os
    import sys
    sys.path.insert(0, os.path.dirname(__file__))
    from gateway_api import GatewayWebSocketClient


@dataclass
class Targets:
    temp_c: float = 25.0
    humi_pct: float = 65.0
    co2_ppm: float = 850.0
    light_lux: float = 900.0
    soil_humi_pct: float = 55.0


@dataclass
class ActuatorDecision:
    heater: bool
    humidifier: bool
    exhaust_fan: bool
    grow_light: bool
    curtain: bool
    pump: bool
    alarm_light: bool


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


class FuzzyBrain:
    def __init__(self, targets: Targets) -> None:
        self.targets = targets

        t_universe = np.arange(0, 41, 0.1)
        h_universe = np.arange(0, 101, 0.5)
        c_universe = np.arange(200, 2001, 5)
        l_universe = np.arange(0, 2001, 5)
        s_universe = np.arange(0, 101, 0.5)
        o_universe = np.arange(0, 1.01, 0.01)

        self.temp = ctrl.Antecedent(t_universe, "temp")
        self.humi = ctrl.Antecedent(h_universe, "humi")
        self.co2 = ctrl.Antecedent(c_universe, "co2")
        self.light = ctrl.Antecedent(l_universe, "light")
        self.soil = ctrl.Antecedent(s_universe, "soil")

        self.heater = ctrl.Consequent(o_universe, "heater")
        self.humidifier = ctrl.Consequent(o_universe, "humidifier")
        self.exhaust_fan = ctrl.Consequent(o_universe, "exhaust_fan")
        self.grow_light = ctrl.Consequent(o_universe, "grow_light")
        self.curtain = ctrl.Consequent(o_universe, "curtain")
        self.pump = ctrl.Consequent(o_universe, "pump")

        self._build_memberships()
        self._build_rules()

        self.system = ctrl.ControlSystem(self.rules)

    def _build_memberships(self) -> None:
        t = self.targets

        self.temp["cold"] = fuzz.trapmf(self.temp.universe, [0, 0, t.temp_c - 8, t.temp_c - 3])
        self.temp["ok"] = fuzz.trimf(self.temp.universe, [t.temp_c - 4, t.temp_c, t.temp_c + 4])
        self.temp["hot"] = fuzz.trapmf(self.temp.universe, [t.temp_c + 2, t.temp_c + 6, 40, 40])

        self.humi["dry"] = fuzz.trapmf(self.humi.universe, [0, 0, t.humi_pct - 25, t.humi_pct - 10])
        self.humi["ok"] = fuzz.trimf(self.humi.universe, [t.humi_pct - 12, t.humi_pct, t.humi_pct + 12])
        self.humi["wet"] = fuzz.trapmf(self.humi.universe, [t.humi_pct + 8, t.humi_pct + 18, 100, 100])

        self.co2["low"] = fuzz.trapmf(self.co2.universe, [200, 200, t.co2_ppm - 450, t.co2_ppm - 200])
        self.co2["ok"] = fuzz.trimf(self.co2.universe, [t.co2_ppm - 250, t.co2_ppm, t.co2_ppm + 250])
        self.co2["high"] = fuzz.trapmf(self.co2.universe, [t.co2_ppm + 200, t.co2_ppm + 500, 2000, 2000])

        self.light["low"] = fuzz.trapmf(self.light.universe, [0, 0, t.light_lux - 650, t.light_lux - 250])
        self.light["ok"] = fuzz.trimf(self.light.universe, [t.light_lux - 350, t.light_lux, t.light_lux + 350])
        self.light["high"] = fuzz.trapmf(self.light.universe, [t.light_lux + 250, t.light_lux + 650, 2000, 2000])

        self.soil["dry"] = fuzz.trapmf(self.soil.universe, [0, 0, t.soil_humi_pct - 30, t.soil_humi_pct - 12])
        self.soil["ok"] = fuzz.trimf(self.soil.universe, [t.soil_humi_pct - 15, t.soil_humi_pct, t.soil_humi_pct + 15])
        self.soil["wet"] = fuzz.trapmf(self.soil.universe, [t.soil_humi_pct + 10, t.soil_humi_pct + 25, 100, 100])

        for out in (self.heater, self.humidifier, self.exhaust_fan, self.grow_light, self.curtain, self.pump):
            out["off"] = fuzz.trimf(out.universe, [0.0, 0.0, 0.45])
            out["mid"] = fuzz.trimf(out.universe, [0.25, 0.55, 0.85])
            out["on"] = fuzz.trimf(out.universe, [0.6, 1.0, 1.0])

    def _build_rules(self) -> None:
        r = []

        r += [
            ctrl.Rule(self.temp["cold"], self.heater["on"]),
            ctrl.Rule(self.temp["ok"], self.heater["off"]),
            ctrl.Rule(self.temp["hot"], self.heater["off"]),
        ]

        r += [
            ctrl.Rule(self.humi["dry"], self.humidifier["on"]),
            ctrl.Rule(self.humi["ok"], self.humidifier["off"]),
            ctrl.Rule(self.humi["wet"], self.humidifier["off"]),
        ]

        r += [
            ctrl.Rule(self.temp["hot"], self.exhaust_fan["on"]),
            ctrl.Rule(self.humi["wet"], self.exhaust_fan["mid"]),
            ctrl.Rule(self.co2["high"], self.exhaust_fan["mid"]),
            ctrl.Rule(self.temp["cold"] & self.humi["dry"], self.exhaust_fan["off"]),
            ctrl.Rule(self.co2["low"] & self.temp["ok"], self.exhaust_fan["off"]),
        ]

        r += [
            ctrl.Rule(self.light["low"], self.grow_light["on"]),
            ctrl.Rule(self.light["ok"], self.grow_light["off"]),
            ctrl.Rule(self.light["high"], self.grow_light["off"]),
        ]

        r += [
            ctrl.Rule(self.light["high"], self.curtain["on"]),
            ctrl.Rule(self.light["ok"], self.curtain["off"]),
            ctrl.Rule(self.light["low"], self.curtain["off"]),
        ]

        r += [
            ctrl.Rule(self.soil["dry"], self.pump["on"]),
            ctrl.Rule(self.soil["ok"], self.pump["off"]),
            ctrl.Rule(self.soil["wet"], self.pump["off"]),
        ]

        self.rules = r

    def decide(self, sensors: Dict[str, object]) -> ActuatorDecision:
        temp = float(sensors.get("airTemp", 25.0))
        humi = float(sensors.get("airHumi", 65.0))
        co2 = float(sensors.get("co2", 800.0))
        light = float(sensors.get("light", 900.0))
        soil = float(sensors.get("soilHumi", 55.0))
        smoke = bool(sensors.get("smoke", False))

        sim = ctrl.ControlSystemSimulation(self.system)
        sim.input["temp"] = clamp(temp, 0, 40)
        sim.input["humi"] = clamp(humi, 0, 100)
        sim.input["co2"] = clamp(co2, 200, 2000)
        sim.input["light"] = clamp(light, 0, 2000)
        sim.input["soil"] = clamp(soil, 0, 100)

        sim.compute()

        heater = float(sim.output.get("heater", 0.0)) > 0.55
        humidifier = float(sim.output.get("humidifier", 0.0)) > 0.55
        exhaust_fan = float(sim.output.get("exhaust_fan", 0.0)) > 0.55
        grow_light = float(sim.output.get("grow_light", 0.0)) > 0.55
        curtain = float(sim.output.get("curtain", 0.0)) > 0.55
        pump = float(sim.output.get("pump", 0.0)) > 0.55
        alarm_light = smoke

        if exhaust_fan:
            if heater:
                heater = False
            if humidifier:
                humidifier = False

        return ActuatorDecision(
            heater=heater,
            humidifier=humidifier,
            exhaust_fan=exhaust_fan,
            grow_light=grow_light,
            curtain=curtain,
            pump=pump,
            alarm_light=alarm_light,
        )


class ActuatorDriver:
    def __init__(self, min_hold_s: float) -> None:
        self.min_hold_s = min_hold_s
        self.last_value: Dict[str, bool] = {}
        self.last_change_at: Dict[str, float] = {}

    def should_apply(self, key: str, value: bool) -> bool:
        prev = self.last_value.get(key)
        now = time.monotonic()
        if prev is None:
            self.last_value[key] = value
            self.last_change_at[key] = 0.0
            return True
        if prev == value:
            return False
        last_at = self.last_change_at.get(key, 0.0)
        if now - last_at < self.min_hold_s:
            return False
        self.last_value[key] = value
        self.last_change_at[key] = now
        return True


@dataclass
class ControllerParams:
    ws_host: str = "localhost"
    ws_port: int = 8080
    interval_s: float = 2.0
    hold_s: float = 6.0
    targets: Targets = field(default_factory=Targets)


@dataclass
class ControllerState:
    sensors: Dict[str, object] = field(default_factory=dict)
    actuators: Dict[str, bool] = field(default_factory=dict)
    running: bool = False
    last_error: Optional[str] = None
    last_update_ts: float = 0.0


class GrowthController:
    def __init__(self, params: Optional[ControllerParams] = None) -> None:
        self.params = params or ControllerParams()
        self._state = ControllerState()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_thread, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def update_params(self, params: ControllerParams) -> None:
        with self._lock:
            self.params = params

    def get_state(self) -> ControllerState:
        with self._lock:
            return ControllerState(
                sensors=dict(self._state.sensors),
                actuators=dict(self._state.actuators),
                running=self._state.running,
                last_error=self._state.last_error,
                last_update_ts=self._state.last_update_ts,
            )

    def _run_thread(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._run_async())
        loop.close()

    async def _run_async(self) -> None:
        cache: Dict[str, object] = {}
        driver = ActuatorDriver(min_hold_s=self.params.hold_s)
        while not self._stop.is_set():
            params = self._read_params()
            brain = FuzzyBrain(params.targets)
            try:
                client = GatewayWebSocketClient(host=params.ws_host, port=params.ws_port, secure=False)
                await client.connect()
                with self._lock:
                    self._state.running = True
                    self._state.last_error = None
                while not self._stop.is_set():
                    snapshot = await client.query_all_sensors(timeout=2.5)
                    cache.update({k: v for k, v in snapshot.items() if v is not None})

                    decision = brain.decide(cache)
                    plan = {
                        "heater": decision.heater,
                        "humidifier": decision.humidifier,
                        "exhaustFan": decision.exhaust_fan,
                        "growLight": decision.grow_light,
                        "curtain": decision.curtain,
                        "pump": decision.pump,
                    }
                    for dev_id, val in plan.items():
                        if driver.should_apply(dev_id, bool(val)):
                            await client.set_actuator(dev_id, bool(val))
                    if decision.alarm_light:
                        if driver.should_apply("alarmLight", True):
                            await client.set_actuator("alarmLight", True)
                    with self._lock:
                        self._state.sensors = dict(cache)
                        self._state.actuators = dict(plan)
                        self._state.last_update_ts = time.time()
                    await asyncio.sleep(params.interval_s)
            except Exception as e:
                with self._lock:
                    self._state.running = False
                    self._state.last_error = str(e)
                await asyncio.sleep(1.5)
            finally:
                try:
                    await client.close()
                except Exception:
                    pass

        with self._lock:
            self._state.running = False

    def _read_params(self) -> ControllerParams:
        with self._lock:
            return ControllerParams(
                ws_host=self.params.ws_host,
                ws_port=self.params.ws_port,
                interval_s=self.params.interval_s,
                hold_s=self.params.hold_s,
                targets=Targets(
                    temp_c=self.params.targets.temp_c,
                    humi_pct=self.params.targets.humi_pct,
                    co2_ppm=self.params.targets.co2_ppm,
                    light_lux=self.params.targets.light_lux,
                    soil_humi_pct=self.params.targets.soil_humi_pct,
                ),
            )


def start_gui(initial: ControllerParams) -> None:
    import tkinter as tk
    from tkinter import ttk

    controller = GrowthController(initial)

    root = tk.Tk()
    root.title("Fuzzy Growth Controller")
    root.geometry("760x560")

    texts = {
        "en": {
            "title": "Fuzzy Growth Controller",
            "lang": "Language",
            "apply": "Apply",
            "start": "Start",
            "stop": "Stop",
            "status_idle": "status: idle",
            "status_run": "status: running",
            "status_stop": "status: stopped",
            "status_err": "error",
            "sensors": "Sensors",
            "actuators": "Actuators",
            "ws_host": "WebSocket Host",
            "ws_port": "WebSocket Port",
            "interval_s": "Loop Interval (s)",
            "hold_s": "Min Hold (s)",
            "temp_c": "Target Temp (°C)",
            "humi_pct": "Target Humi (%)",
            "co2_ppm": "Target CO2 (ppm)",
            "light_lux": "Target Light (lux)",
            "soil_humi_pct": "Target Soil Humi (%)",
        },
        "zh": {
            "title": "模糊控制器（植物生长）",
            "lang": "语言",
            "apply": "应用",
            "start": "启动",
            "stop": "停止",
            "status_idle": "状态：空闲",
            "status_run": "状态：运行中",
            "status_stop": "状态：已停止",
            "status_err": "错误",
            "sensors": "传感器",
            "actuators": "执行器",
            "ws_host": "WebSocket 地址",
            "ws_port": "WebSocket 端口",
            "interval_s": "循环间隔(秒)",
            "hold_s": "最小保持(秒)",
            "temp_c": "目标温度(°C)",
            "humi_pct": "目标湿度(%)",
            "co2_ppm": "目标二氧化碳(ppm)",
            "light_lux": "目标光照(lux)",
            "soil_humi_pct": "目标土壤湿度(%)",
        },
    }

    lang_var = tk.StringVar(value="zh")
    label_widgets: Dict[str, ttk.Label] = {}
    button_widgets: Dict[str, ttk.Button] = {}

    vars_map: Dict[str, tk.StringVar] = {}
    fields = [
        ("ws_host", "WebSocket Host", initial.ws_host),
        ("ws_port", "WebSocket Port", str(initial.ws_port)),
        ("interval_s", "Loop Interval (s)", str(initial.interval_s)),
        ("hold_s", "Min Hold (s)", str(initial.hold_s)),
        ("temp_c", "Target Temp (°C)", str(initial.targets.temp_c)),
        ("humi_pct", "Target Humi (%)", str(initial.targets.humi_pct)),
        ("co2_ppm", "Target CO2 (ppm)", str(initial.targets.co2_ppm)),
        ("light_lux", "Target Light (lux)", str(initial.targets.light_lux)),
        ("soil_humi_pct", "Target Soil Humi (%)", str(initial.targets.soil_humi_pct)),
    ]

    form = ttk.Frame(root, padding=12)
    form.pack(fill="x")

    for i, (key, label, default) in enumerate(fields):
        lbl = ttk.Label(form, text=label, width=22)
        lbl.grid(row=i, column=0, sticky="w", pady=4)
        label_widgets[key] = lbl
        var = tk.StringVar(value=default)
        vars_map[key] = var
        entry = ttk.Entry(form, textvariable=var, width=18)
        entry.grid(row=i, column=1, sticky="w", pady=4)

    button_row = ttk.Frame(form)
    button_row.grid(row=len(fields), column=0, columnspan=2, sticky="w", pady=8)

    lang_row = ttk.Frame(form)
    lang_row.grid(row=len(fields) + 1, column=0, columnspan=2, sticky="w", pady=4)
    lang_label = ttk.Label(lang_row, text="Language", width=22)
    lang_label.pack(side="left")
    label_widgets["lang"] = lang_label
    lang_select = ttk.Combobox(lang_row, textvariable=lang_var, values=["zh", "en"], width=8, state="readonly")
    lang_select.pack(side="left", padx=4)

    def apply_params() -> None:
        try:
            params = ControllerParams(
                ws_host=vars_map["ws_host"].get().strip(),
                ws_port=int(vars_map["ws_port"].get()),
                interval_s=float(vars_map["interval_s"].get()),
                hold_s=float(vars_map["hold_s"].get()),
                targets=Targets(
                    temp_c=float(vars_map["temp_c"].get()),
                    humi_pct=float(vars_map["humi_pct"].get()),
                    co2_ppm=float(vars_map["co2_ppm"].get()),
                    light_lux=float(vars_map["light_lux"].get()),
                    soil_humi_pct=float(vars_map["soil_humi_pct"].get()),
                ),
            )
            controller.update_params(params)
        except Exception:
            return

    def start_control() -> None:
        apply_params()
        controller.start()

    def stop_control() -> None:
        controller.stop()

    btn_apply = ttk.Button(button_row, text="Apply", command=apply_params)
    btn_start = ttk.Button(button_row, text="Start", command=start_control)
    btn_stop = ttk.Button(button_row, text="Stop", command=stop_control)
    btn_apply.pack(side="left", padx=4)
    btn_start.pack(side="left", padx=4)
    btn_stop.pack(side="left", padx=4)
    button_widgets["apply"] = btn_apply
    button_widgets["start"] = btn_start
    button_widgets["stop"] = btn_stop

    status = ttk.Label(root, text="status: idle", padding=8)
    status.pack(fill="x")

    info = ttk.Frame(root, padding=12)
    info.pack(fill="both", expand=True)

    sensor_frame = ttk.LabelFrame(info, text="Sensors", padding=8)
    sensor_frame.pack(side="left", fill="both", expand=True, padx=6)

    actuator_frame = ttk.LabelFrame(info, text="Actuators", padding=8)
    actuator_frame.pack(side="right", fill="both", expand=True, padx=6)

    sensor_vars = {k: tk.StringVar(value="-") for k in ["airTemp", "airHumi", "co2", "light", "soilHumi", "windSpeed", "windDir", "ph", "rainSnow", "pir", "smoke"]}
    actuator_vars = {k: tk.StringVar(value="-") for k in ["heater", "humidifier", "exhaustFan", "growLight", "curtain", "pump", "alarmLight"]}

    for i, key in enumerate(sensor_vars.keys()):
        ttk.Label(sensor_frame, text=key, width=14).grid(row=i, column=0, sticky="w", pady=2)
        ttk.Label(sensor_frame, textvariable=sensor_vars[key]).grid(row=i, column=1, sticky="w", pady=2)

    for i, key in enumerate(actuator_vars.keys()):
        ttk.Label(actuator_frame, text=key, width=14).grid(row=i, column=0, sticky="w", pady=2)
        ttk.Label(actuator_frame, textvariable=actuator_vars[key]).grid(row=i, column=1, sticky="w", pady=2)

    def apply_language() -> None:
        lang = lang_var.get()
        t = texts.get(lang, texts["zh"])
        root.title(t["title"])
        for key, lbl in label_widgets.items():
            if key in t:
                lbl.config(text=t[key])
        btn_apply.config(text=t["apply"])
        btn_start.config(text=t["start"])
        btn_stop.config(text=t["stop"])
        sensor_frame.config(text=t["sensors"])
        actuator_frame.config(text=t["actuators"])
        if controller.get_state().running:
            status.config(text=f"{t['status_run']}  {t['status_err']}: {controller.get_state().last_error or '-'}")
        else:
            status.config(text=t["status_idle"])

    def on_lang_change(_: object = None) -> None:
        apply_language()

    lang_select.bind("<<ComboboxSelected>>", on_lang_change)
    apply_language()

    def refresh() -> None:
        st = controller.get_state()
        t = texts.get(lang_var.get(), texts["zh"])
        if st.running:
            status.config(text=f"{t['status_run']}  {t['status_err']}: {st.last_error or '-'}")
        else:
            status.config(text=f"{t['status_stop']}  {t['status_err']}: {st.last_error or '-'}")
        for key, var in sensor_vars.items():
            val = st.sensors.get(key, "-")
            var.set(str(val))
        for key, var in actuator_vars.items():
            val = st.actuators.get(key, "-")
            var.set(str(val))
        root.after(500, refresh)

    def on_close() -> None:
        controller.stop()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    refresh()
    root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ws-host", default="localhost")
    p.add_argument("--ws-port", type=int, default=8080)
    p.add_argument("--interval", type=float, default=2.0)
    p.add_argument("--hold", type=float, default=6.0)
    p.add_argument("--target-temp", type=float, default=25.0)
    p.add_argument("--target-humi", type=float, default=65.0)
    p.add_argument("--target-co2", type=float, default=850.0)
    p.add_argument("--target-light", type=float, default=900.0)
    p.add_argument("--target-soil", type=float, default=55.0)
    p.add_argument("--cli", action="store_true")
    args = p.parse_args()

    params = ControllerParams(
        ws_host=args.ws_host,
        ws_port=args.ws_port,
        interval_s=args.interval,
        hold_s=args.hold,
        targets=Targets(
            temp_c=args.target_temp,
            humi_pct=args.target_humi,
            co2_ppm=args.target_co2,
            light_lux=args.target_light,
            soil_humi_pct=args.target_soil,
        ),
    )

    if args.cli:
        controller = GrowthController(params)
        controller.start()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            controller.stop()
    else:
        start_gui(params)


if __name__ == "__main__":
    main()
