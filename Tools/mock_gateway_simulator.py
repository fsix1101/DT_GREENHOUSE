from __future__ import annotations

import argparse
import asyncio
import random
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

try:
    from gateway_api import (
        ACTUATOR_DEVICES,
        SENSOR_DEVICES,
        Addr,
        Command,
        DataType,
        Head,
        ActuatorControlToggle,
        ActuatorControlTrigger,
        pack_frame,
        unpack_frame,
        payload_bool,
        payload_float,
        payload_int,
    )
except Exception:
    from enum import IntEnum
    from dataclasses import dataclass
    from typing import Union, Optional

    class Head(IntEnum):
        PC_TO_NODE = 0xCC
        NODE_TO_PC = 0xBB

    class DeviceMainType(IntEnum):
        IO = 0x01
        POWER_CONTROL = 0x02
        COMMUNICATION = 0x03
        DEFAULT = 0xFF

    class Command(IntEnum):
        CONTROL = 0x01
        QUERY = 0x02
        REPORT = 0x03

    class DataType(IntEnum):
        BOOL = 0x01
        INT = 0x02
        FLOAT = 0x03
        ARRAY = 0x04
        STRING = 0x05

    Bytes = bytes

    @dataclass
    class Addr:
        main_type: DeviceMainType
        sub_type: int
        index: int

    @dataclass
    class ProtocolFrame:
        head: Head
        length: int
        addr: Addr
        cmd: Command
        data_type: DataType
        data: Bytes
        verification: int

    @dataclass
    class UnpackResult:
        frame: ProtocolFrame
        crc_ok: bool

    def calculate_crc16_modbus(data: Bytes) -> int:
        crc = 0xFFFF
        for b in data:
            crc ^= b
            for _ in range(8):
                if crc & 0x0001:
                    crc = (crc >> 1) ^ 0xA001
                else:
                    crc >>= 1
        return crc & 0xFFFF

    def pack_frame(head: Head, addr: Addr, cmd: Command, data_type: DataType, data: Bytes) -> Bytes:
        if len(data) != 6:
            raise ValueError("data must be 6 bytes")
        buffer = bytearray(16)
        buffer[0] = int(head)
        buffer[1] = 0x10
        buffer[2] = int(addr.main_type)
        buffer[3] = (addr.sub_type >> 8) & 0xFF
        buffer[4] = addr.sub_type & 0xFF
        buffer[5] = addr.index & 0xFF
        buffer[6] = int(cmd)
        buffer[7] = int(data_type)
        buffer[8:14] = data
        crc = calculate_crc16_modbus(buffer[:14])
        buffer[14] = crc & 0xFF
        buffer[15] = (crc >> 8) & 0xFF
        return bytes(buffer)

    def unpack_frame(buffer: Bytes) -> Optional[UnpackResult]:
        if len(buffer) != 16:
            return None
        verification = ((buffer[15] & 0xFF) << 8) | (buffer[14] & 0xFF)
        calculated = calculate_crc16_modbus(buffer[:14])
        addr = Addr(
            main_type=DeviceMainType(buffer[2]),
            sub_type=((buffer[3] & 0xFF) << 8) | (buffer[4] & 0xFF),
            index=buffer[5] & 0xFF,
        )
        frame = ProtocolFrame(
            head=Head(buffer[0]),
            length=buffer[1],
            addr=addr,
            cmd=Command(buffer[6]),
            data_type=DataType(buffer[7]),
            data=bytes(buffer[8:14]),
            verification=verification,
        )
        return UnpackResult(frame=frame, crc_ok=calculated == verification)

    def payload_bool(val: bool) -> Bytes:
        arr = bytearray(6)
        arr[5] = 1 if val else 0
        return bytes(arr)

    def payload_int(val: int) -> Bytes:
        arr = bytearray(6)
        v = int(val)
        sign = 1 if v < 0 else 0
        abs_v = abs(v)
        arr[0] = sign
        arr[1] = (abs_v >> 24) & 0xFF
        arr[2] = (abs_v >> 16) & 0xFF
        arr[3] = (abs_v >> 8) & 0xFF
        arr[4] = abs_v & 0xFF
        return bytes(arr)

    def payload_float(val: float) -> Bytes:
        scaled = int(round(val * 10000))
        arr = bytearray(6)
        sign = 1 if scaled < 0 else 0
        abs_v = abs(scaled)
        arr[0] = sign
        arr[1] = (abs_v >> 24) & 0xFF
        arr[2] = (abs_v >> 16) & 0xFF
        arr[3] = (abs_v >> 8) & 0xFF
        arr[4] = abs_v & 0xFF
        return bytes(arr)

    @dataclass
    class ActuatorControlToggle:
        on: str
        off: str

    @dataclass
    class ActuatorControlTrigger:
        fire: str

    @dataclass
    class SensorDevice:
        id: str
        name: str
        main_type: DeviceMainType
        sub_type: int
        index: int

    @dataclass
    class ActuatorDevice:
        id: str
        name: str
        main_type: DeviceMainType
        sub_type: int
        index: int
        control: Union[ActuatorControlToggle, ActuatorControlTrigger]

    SENSOR_DEVICES: List[SensorDevice] = [
        SensorDevice("airTemp", "空气温度", DeviceMainType.COMMUNICATION, 0x0002, 0x01),
        SensorDevice("airHumi", "空气湿度", DeviceMainType.COMMUNICATION, 0x0003, 0x01),
        SensorDevice("rainSnow", "雨雪", DeviceMainType.IO, 0x0004, 0x00),
        SensorDevice("light", "光照强度", DeviceMainType.COMMUNICATION, 0x0001, 0x00),
        SensorDevice("pir", "人体感应", DeviceMainType.IO, 0x0003, 0x00),
        SensorDevice("soilTemp", "土壤温度", DeviceMainType.IO, 0x000B, 0x00),
        SensorDevice("soilHumi", "土壤湿度", DeviceMainType.IO, 0x000A, 0x00),
        SensorDevice("co2", "CO2 浓度", DeviceMainType.COMMUNICATION, 0x000A, 0x00),
        SensorDevice("windSpeed", "风速", DeviceMainType.COMMUNICATION, 0x000D, 0x00),
        SensorDevice("windDir", "风向", DeviceMainType.COMMUNICATION, 0x000E, 0x00),
        SensorDevice("ph", "PH 值", DeviceMainType.COMMUNICATION, 0x000F, 0x00),
    ]

    ACTUATOR_DEVICES: List[ActuatorDevice] = [
        ActuatorDevice("exhaustFan", "换气扇", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A200010400000000AAA9C0C3", "CC100300A200010400000000AAA80103")),
        ActuatorDevice("growLight", "植物生长灯", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A200010400000000AA9A80D6", "CC100300A200010400000000AA8A811A")),
        ActuatorDevice("humidifier", "加湿器", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A200010400000000AAA680C7", "CC100300A200010400000000AAA28104")),
        ActuatorDevice("heater", "加热器", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A200010400000000AA6A8092", "CC100300A200010400000000AA2A8162")),
        ActuatorDevice("curtain", "智能窗帘", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A2000104000000001AAAF502", "CC100300A2000104000000004AAAC902")),
        ActuatorDevice("pump", "水泵控制", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlToggle("CC100300A200010400000000A9AA8032", "CC100300A200010400000000A8AA81A2")),
        ActuatorDevice("alarmLight", "报警灯", DeviceMainType.COMMUNICATION, 0x00A2, 0x00, ActuatorControlTrigger("CC100300A200010400000000A2AA8702")),
    ]


for device in SENSOR_DEVICES:
    if device.id == "co2":
        device.index = 0x01


SENSOR_DATA_TYPE: Dict[str, DataType] = {
    "airTemp": DataType.FLOAT,
    "airHumi": DataType.INT,
    "rainSnow": DataType.BOOL,
    "light": DataType.INT,
    "pir": DataType.BOOL,
    "soilTemp": DataType.FLOAT,
    "soilHumi": DataType.INT,
    "co2": DataType.INT,
    "windSpeed": DataType.FLOAT,
    "windDir": DataType.INT,
    "ph": DataType.FLOAT,
    "smoke": DataType.BOOL,
}


ROLE_BY_ACTUATOR_ID: Dict[str, str] = {
    "exhaustFan": "exhaustFan",
    "growLight": "growLight",
    "humidifier": "humidifier",
    "heater": "heater",
    "curtain": "curtain",
    "pump": "pump",
    "alarmLight": "alarmLight",
}


def build_actuator_hex_actions() -> Dict[str, Tuple[str, bool]]:
    actions: Dict[str, Tuple[str, bool]] = {}
    for device in ACTUATOR_DEVICES:
        role = ROLE_BY_ACTUATOR_ID.get(device.id, device.id)
        ctrl = device.control
        if isinstance(ctrl, ActuatorControlToggle):
            actions[ctrl.on.upper()] = (role, True)
            actions[ctrl.off.upper()] = (role, False)
        elif isinstance(ctrl, ActuatorControlTrigger):
            actions[ctrl.fire.upper()] = (role, True)
    return actions


def bytes_to_hex(buffer: bytes) -> str:
    return buffer.hex().upper()


@dataclass
class SensorState:
    values: Dict[str, float]
    flags: Dict[str, bool]


class SimulatorModel:
    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.flags = {
            "rainSnow": False,
            "pir": False,
            "smoke": False,
        }
        self.values = {
            "airTemp": 24.5,
            "airHumi": 55.0,
            "light": 500.0,
            "soilTemp": 22.5,
            "soilHumi": 45.0,
            "co2": 650.0,
            "windSpeed": 1.2,
            "windDir": 120.0,
            "ph": 6.8,
            "smoke": False,
        }
        self.actuators = {
            "exhaustFan": False,
            "growLight": False,
            "humidifier": False,
            "heater": False,
            "curtain": False,
            "pump": False,
            "alarmLight": False,
        }
        self.alarm_until = 0.0

    def set_actuator(self, name: str, enabled: bool) -> None:
        if name not in self.actuators:
            return
        if name == "alarmLight" and enabled:
            self.alarm_until = time.monotonic() + 5.0
            self.actuators[name] = True
            return
        self.actuators[name] = enabled

    def _target_values(self) -> Dict[str, float]:
        target = {
            "airTemp": 24.0,
            "airHumi": 55.0,
            "light": 480.0,
            "soilTemp": 22.0,
            "soilHumi": 43.0,
            "co2": 650.0,
            "windSpeed": 1.0,
            "windDir": self.values["windDir"],
            "ph": 6.8,
        }
        if self.actuators["growLight"]:
            target["light"] += 650.0
        if self.actuators["curtain"]:
            target["light"] -= 380.0
        if self.actuators["heater"]:
            target["airTemp"] += 3.5
        if self.actuators["humidifier"]:
            target["airHumi"] += 12.0
        if self.actuators["exhaustFan"]:
            target["airTemp"] -= 1.8
            target["airHumi"] -= 8.0
            target["co2"] -= 140.0
            target["windSpeed"] += 1.6
        if self.actuators["pump"]:
            target["soilHumi"] += 12.0
        target["soilTemp"] = target["airTemp"] - 1.2
        return target

    def update(self, dt: float) -> SensorState:
        if self.actuators["alarmLight"] and time.monotonic() >= self.alarm_until:
            self.actuators["alarmLight"] = False

        target = self._target_values()
        for key, current in self.values.items():
            t = target.get(key, current)
            jitter = self.rng.uniform(-0.18, 0.18)
            next_val = current + (t - current) * min(1.0, dt * 0.35) + jitter
            if key == "airTemp":
                next_val = max(10.0, min(38.0, next_val))
            elif key == "airHumi":
                next_val = max(15.0, min(98.0, next_val))
            elif key == "light":
                next_val = max(50.0, min(2000.0, next_val))
            elif key == "soilTemp":
                next_val = max(5.0, min(35.0, next_val))
            elif key == "soilHumi":
                next_val = max(10.0, min(95.0, next_val))
            elif key == "smoke":
                next_val = self.flags["smoke"]
            elif key == "co2":
                next_val = max(350.0, min(2000.0, next_val))
            elif key == "windSpeed":
                next_val = max(0.0, min(8.0, next_val))
            elif key == "windDir":
                next_val = (next_val + self.rng.uniform(-6, 6)) % 360
            elif key == "ph":
                next_val = max(5.0, min(8.5, next_val))
            self.values[key] = next_val

        rain_chance = 0.004 * dt
        pir_chance = 0.06 * dt
        smoke_chance = 0.001 * dt
        if self.rng.random() < rain_chance:
            self.flags["rainSnow"] = not self.flags["rainSnow"]
        if self.rng.random() < pir_chance:
            self.flags["pir"] = not self.flags["pir"]
        if self.rng.random() < smoke_chance:
            self.flags["smoke"] = not self.flags["smoke"]
        if self.actuators["alarmLight"]:
            self.flags["smoke"] = True

        return SensorState(values=self.values.copy(), flags=self.flags.copy())


def payload_int16(val: float) -> bytes:
    v = int(round(val))
    v = max(0, min(65535, v))
    arr = bytearray(6)
    arr[4] = (v >> 8) & 0xFF
    arr[5] = v & 0xFF
    return bytes(arr)


def payload_u8(val: float) -> bytes:
    v = int(round(val))
    v = max(0, min(255, v))
    arr = bytearray(6)
    arr[5] = v & 0xFF
    return bytes(arr)


def payload_float_air(val: float) -> bytes:
    scaled = int(round(val * 10000))
    sign = 1 if scaled < 0 else 0
    abs_v = abs(scaled)
    arr = bytearray(6)
    arr[1] = sign
    arr[2] = (abs_v >> 24) & 0xFF
    arr[3] = (abs_v >> 16) & 0xFF
    arr[4] = (abs_v >> 8) & 0xFF
    arr[5] = abs_v & 0xFF
    return bytes(arr)


def payload_float_unsigned(val: float) -> bytes:
    scaled = int(round(val * 10000))
    abs_v = abs(scaled)
    arr = bytearray(6)
    arr[2] = (abs_v >> 24) & 0xFF
    arr[3] = (abs_v >> 16) & 0xFF
    arr[4] = (abs_v >> 8) & 0xFF
    arr[5] = abs_v & 0xFF
    return bytes(arr)


def encode_sensor_value(device_id: str, state: SensorState) -> Tuple[DataType, bytes]:
    data_type = SENSOR_DATA_TYPE.get(device_id, DataType.FLOAT)
    if data_type == DataType.BOOL:
        val = state.flags.get(device_id, False)
        return data_type, payload_bool(bool(val))
    value = state.values.get(device_id, 0.0)
    if device_id in ("light", "co2", "windDir"):
        return DataType.INT, payload_int16(value)
    if device_id in ("airHumi", "soilHumi"):
        return DataType.INT, payload_u8(value)
    if device_id in ("airTemp", "soilTemp"):
        return DataType.FLOAT, payload_float_air(value)
    if device_id in ("windSpeed", "ph"):
        return DataType.FLOAT, payload_float_unsigned(value)
    if data_type == DataType.INT:
        return data_type, payload_int(int(round(value)))
    return data_type, payload_float(float(value))


def build_sensor_report(device_id: str, value: SensorState) -> Optional[bytes]:
    device = next((d for d in SENSOR_DEVICES if d.id == device_id), None)
    if device is None:
        return None
    data_type, data = encode_sensor_value(device_id, value)
    addr = Addr(main_type=device.main_type, sub_type=device.sub_type, index=device.index)
    return pack_frame(
        head=Head.NODE_TO_PC,
        addr=addr,
        cmd=Command.REPORT,
        data_type=data_type,
        data=data,
    )


class TcpSimulatorServer:
    def __init__(self, host: str, port: int, interval: float, seed: int) -> None:
        self.host = host
        self.port = port
        self.interval = interval
        self.model = SimulatorModel(seed)
        self.clients: List[asyncio.StreamWriter] = []
        self.hex_actions = build_actuator_hex_actions()

    async def start(self) -> None:
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        addr = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
        print(f"mock simulator listening on {addr}")
        async with server:
            await asyncio.gather(server.serve_forever(), self.broadcast_loop())

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        self.clients.append(writer)
        print(f"client connected {peer}")
        buffer = ""
        try:
            while not reader.at_eof():
                data = await reader.read(4096)
                if not data:
                    break
                chunk = "".join(ch for ch in data.decode("utf-8", "ignore") if ch in "0123456789abcdefABCDEF")
                if not chunk:
                    continue
                buffer += chunk.upper()
                while len(buffer) >= 32:
                    frame_hex = buffer[:32]
                    buffer = buffer[32:]
                    try:
                        frame_bytes = bytes.fromhex(frame_hex)
                    except ValueError:
                        continue
                    await self.handle_frame(frame_bytes)
        finally:
            if writer in self.clients:
                self.clients.remove(writer)
            writer.close()
            await writer.wait_closed()
            print(f"client disconnected {peer}")

    async def handle_frame(self, frame_bytes: bytes) -> None:
        hex_str = bytes_to_hex(frame_bytes)
        if hex_str in self.hex_actions:
            role, enabled = self.hex_actions[hex_str]
            self.model.set_actuator(role, enabled)
            return

        res = unpack_frame(frame_bytes)
        if res is None or not res.crc_ok:
            return
        frame = res.frame
        if frame.head != Head.PC_TO_NODE:
            return
        if frame.cmd == Command.CONTROL and frame.data_type == DataType.BOOL:
            enabled = frame.data[5] == 1 if len(frame.data) > 5 else False
            self.model.set_actuator("exhaustFan", enabled)
            return
        if frame.cmd != Command.QUERY:
            return
        device = next(
            (
                d
                for d in SENSOR_DEVICES
                if d.main_type == frame.addr.main_type
                and d.sub_type == frame.addr.sub_type
                and d.index == frame.addr.index
            ),
            None,
        )
        if device is None:
            return
        snapshot = self.model.update(0.0)
        report = build_sensor_report(device.id, snapshot)
        if report is None:
            return
        await self.broadcast_hex(bytes_to_hex(report))

    async def broadcast_hex(self, hex_str: str) -> None:
        if not self.clients:
            return
        data = hex_str.encode("utf-8")
        for writer in list(self.clients):
            try:
                writer.write(data)
                await writer.drain()
            except ConnectionError:
                if writer in self.clients:
                    self.clients.remove(writer)

    async def broadcast_loop(self) -> None:
        last = time.monotonic()
        while True:
            now = time.monotonic()
            dt = max(0.0, now - last)
            last = now
            snapshot = self.model.update(dt)
            for device in SENSOR_DEVICES:
                report = build_sensor_report(device.id, snapshot)
                if report is None:
                    continue
                await self.broadcast_hex(bytes_to_hex(report))
            await asyncio.sleep(self.interval)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=2012)
    parser.add_argument("--interval", type=float, default=1.5)
    parser.add_argument("--seed", type=int, default=202401)
    args = parser.parse_args()
    server = TcpSimulatorServer(args.host, args.port, args.interval, args.seed)
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
