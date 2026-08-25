from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Dict, List, Optional, Tuple, Union
import asyncio
import websockets


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


def pack_frame(
    head: Head,
    addr: Addr,
    cmd: Command,
    data_type: DataType,
    data: Bytes,
) -> Bytes:
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


def format_hex(buffer: Bytes) -> str:
    return " ".join(f"{b:02X}" for b in buffer)


def payload_bool(val: bool) -> Bytes:
    arr = bytearray(6)
    arr[5] = 1 if val else 0
    return bytes(arr)


def payload_control_byte(val: int) -> Bytes:
    arr = bytearray(6)
    v = int(val)
    arr[5] = v & 0xFF
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


SENSOR_TYPE_BY_MAIN: Dict[int, Dict[int, str]] = {
    0x01: {
        0x0001: "smoke",
        0x0003: "human",
        0x0004: "rainSnow",
        0x000A: "soilHumidity",
        0x000B: "soilTemperature",
    },
    0x03: {
        0x0001: "light",
        0x0002: "airTemperature",
        0x0003: "airHumidity",
        0x000A: "co2",
        0x000D: "windSpeed",
        0x000E: "windDirection",
        0x000F: "ph",
    },
}


def get_sub_type(frame: ProtocolFrame) -> int:
    return frame.addr.sub_type & 0xFFFF


def decode_frame_value(frame: ProtocolFrame) -> Optional[Union[bool, int, float]]:
    sub_type = get_sub_type(frame)
    sensor_type = SENSOR_TYPE_BY_MAIN.get(int(frame.addr.main_type), {}).get(sub_type)
    d = frame.data
    if frame.data_type == DataType.BOOL:
        return (d[5] if len(d) > 5 else 0) == 1
    if frame.data_type == DataType.INT:
        if sensor_type in ("light", "co2", "windDirection"):
            return ((d[4] if len(d) > 4 else 0) << 8) | (d[5] if len(d) > 5 else 0)
        if sensor_type in ("airHumidity", "soilHumidity"):
            return d[5] if len(d) > 5 else 0
        sign = -1 if (d[0] if len(d) > 0 else 0) == 1 else 1
        raw = (
            ((d[1] if len(d) > 1 else 0) << 24)
            | ((d[2] if len(d) > 2 else 0) << 16)
            | ((d[3] if len(d) > 3 else 0) << 8)
            | (d[4] if len(d) > 4 else 0)
        )
        if (
            (d[1] if len(d) > 1 else 0) == 0xFF
            and (d[2] if len(d) > 2 else 0) == 0xFF
            and (d[3] if len(d) > 3 else 0) == 0xFF
            and (d[4] if len(d) > 4 else 0) == 0xFF
        ):
            return None
        return sign * raw
    if frame.data_type == DataType.FLOAT:
        if sensor_type in ("airTemperature", "soilTemperature"):
            if len(d) > 1 and d[1] == 0xFF:
                return None
            raw = (
                ((d[2] if len(d) > 2 else 0) << 24)
                | ((d[3] if len(d) > 3 else 0) << 16)
                | ((d[4] if len(d) > 4 else 0) << 8)
                | (d[5] if len(d) > 5 else 0)
            )
            value = raw / 10000.0
            if len(d) > 1 and d[1] == 1:
                value = -value
            return value
        if sensor_type in ("windSpeed", "ph"):
            raw = (
                ((d[2] if len(d) > 2 else 0) << 24)
                | ((d[3] if len(d) > 3 else 0) << 16)
                | ((d[4] if len(d) > 4 else 0) << 8)
                | (d[5] if len(d) > 5 else 0)
            )
            return raw / 10000.0
        sign = -1 if (d[0] if len(d) > 0 else 0) == 1 else 1
        raw = (
            ((d[1] if len(d) > 1 else 0) << 24)
            | ((d[2] if len(d) > 2 else 0) << 16)
            | ((d[3] if len(d) > 3 else 0) << 8)
            | (d[4] if len(d) > 4 else 0)
        )
        if (
            (d[1] if len(d) > 1 else 0) == 0xFF
            and (d[2] if len(d) > 2 else 0) == 0xFF
            and (d[3] if len(d) > 3 else 0) == 0xFF
            and (d[4] if len(d) > 4 else 0) == 0xFF
        ):
            return None
        value = sign * raw
        return value / 10000.0
    return None


@dataclass
class SensorDevice:
    id: str
    name: str
    main_type: DeviceMainType
    sub_type: int
    index: int


@dataclass
class ActuatorControlToggle:
    on: str
    off: str


@dataclass
class ActuatorControlTrigger:
    fire: str


ActuatorControl = Union[ActuatorControlToggle, ActuatorControlTrigger]


@dataclass
class ActuatorDevice:
    id: str
    name: str
    main_type: DeviceMainType
    sub_type: int
    index: int
    control: ActuatorControl


SENSOR_DEVICES: List[SensorDevice] = [
    SensorDevice("airTemp", "空气温度", DeviceMainType.COMMUNICATION, 0x0002, 0x01),
    SensorDevice("airHumi", "空气湿度", DeviceMainType.COMMUNICATION, 0x0003, 0x01),
    SensorDevice("rainSnow", "雨雪", DeviceMainType.IO, 0x0004, 0x00),
    SensorDevice("light", "光照强度", DeviceMainType.COMMUNICATION, 0x0001, 0x00),
    SensorDevice("pir", "人体感应", DeviceMainType.IO, 0x0003, 0x00),
    SensorDevice("soilTemp", "土壤温度", DeviceMainType.IO, 0x000B, 0x00),
    SensorDevice("soilHumi", "土壤湿度", DeviceMainType.IO, 0x000A, 0x00),
    SensorDevice("co2", "CO2 浓度", DeviceMainType.COMMUNICATION, 0x000A, 0x01),
    SensorDevice("windSpeed", "风速", DeviceMainType.COMMUNICATION, 0x000D, 0x00),
    SensorDevice("windDir", "风向", DeviceMainType.COMMUNICATION, 0x000E, 0x00),
    SensorDevice("ph", "PH 值", DeviceMainType.COMMUNICATION, 0x000F, 0x00),
    SensorDevice("smoke", "烟雾", DeviceMainType.IO, 0x0001, 0x00),
]


ACTUATOR_DEVICES: List[ActuatorDevice] = [
    ActuatorDevice(
        id="exhaustFan",
        name="换气扇",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A200010400000000AAA9C0C3",
            off="CC100300A200010400000000AAA80103",
        ),
    ),
    ActuatorDevice(
        id="growLight",
        name="植物生长灯",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A200010400000000AA9A80D6",
            off="CC100300A200010400000000AA8A811A",
        ),
    ),
    ActuatorDevice(
        id="humidifier",
        name="加湿器",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A200010400000000AAA680C7",
            off="CC100300A200010400000000AAA28104",
        ),
    ),
    ActuatorDevice(
        id="heater",
        name="加热器",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A200010400000000AA6A8092",
            off="CC100300A200010400000000AA2A8162",
        ),
    ),
    ActuatorDevice(
        id="curtain",
        name="智能窗帘",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A2000104000000001AAAF502",
            off="CC100300A2000104000000004AAAC902",
        ),
    ),
    ActuatorDevice(
        id="pump",
        name="水泵控制",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlToggle(
            on="CC100300A200010400000000A9AA8032",
            off="CC100300A200010400000000A8AA81A2",
        ),
    ),
    ActuatorDevice(
        id="alarmLight",
        name="报警灯",
        main_type=DeviceMainType.COMMUNICATION,
        sub_type=0x00A2,
        index=0x00,
        control=ActuatorControlTrigger(
            fire="CC100300A200010400000000A2AA8702",
        ),
    ),
]


def hex_to_bytes(hex_str: str) -> Optional[Bytes]:
    clean = "".join(c for c in hex_str if c in "0123456789abcdefABCDEF")
    if len(clean) != 32:
        return None
    out = bytearray(16)
    for i in range(16):
        part = clean[i * 2 : i * 2 + 2]
        out[i] = int(part, 16)
    return bytes(out)


def build_sensor_query_frame(device: SensorDevice) -> Bytes:
    addr = Addr(
        main_type=device.main_type,
        sub_type=device.sub_type,
        index=device.index,
    )
    data = bytes(6)
    return pack_frame(
        head=Head.PC_TO_NODE,
        addr=addr,
        cmd=Command.QUERY,
        data_type=DataType.BOOL,
        data=data,
    )


def build_all_sensor_query_frames() -> List[Bytes]:
    return [build_sensor_query_frame(d) for d in SENSOR_DEVICES]


def get_actuator_control_frame(device_id: str, value: Union[bool, int]) -> Optional[Bytes]:
    dev = next((d for d in ACTUATOR_DEVICES if d.id == device_id), None)
    if dev is None:
        return None
    ctrl = dev.control
    if isinstance(ctrl, ActuatorControlTrigger):
        hex_str = ctrl.fire
    else:
        if isinstance(value, bool):
            hex_str = ctrl.on if value else ctrl.off
        else:
            hex_str = ctrl.on if value else ctrl.off
    return hex_to_bytes(hex_str)


def parse_incoming_frame(
    raw: Bytes,
) -> Optional[Tuple[str, Union[bool, int, float, None]]]:
    res = unpack_frame(raw)
    if res is None or not res.crc_ok:
        return None
    frame = res.frame
    sub_type = get_sub_type(frame)
    device = next(
        (
            d
            for d in SENSOR_DEVICES
            if d.main_type == frame.addr.main_type and d.sub_type == sub_type and d.index == frame.addr.index
        ),
        None,
    )
    if device is None:
        return None
    value = decode_frame_value(frame)
    return device.id, value


class GatewayWebSocketClient:
    def __init__(self, host: str = "localhost", port: int = 8080, secure: bool = False):
        scheme = "wss" if secure else "ws"
        self.url = f"{scheme}://{host}:{port}"
        self.ws: Optional[websockets.WebSocketClientProtocol] = None

    async def connect(self) -> None:
        self.ws = await websockets.connect(self.url)

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()
            self.ws = None

    async def send_frame(self, frame: Bytes) -> None:
        if self.ws is None:
            raise RuntimeError("WebSocket is not connected")
        if len(frame) != 16:
            raise ValueError("frame must be 16 bytes")
        await self.ws.send(frame)

    async def recv_parsed(self) -> Optional[Tuple[str, Union[bool, int, float, None]]]:
        if self.ws is None:
            raise RuntimeError("WebSocket is not connected")
        msg = await self.ws.recv()
        if isinstance(msg, str):
            return None
        if not isinstance(msg, (bytes, bytearray)):
            return None
        raw = bytes(msg)
        return parse_incoming_frame(raw)

    async def query_all_sensors(self, timeout: float = 3.0) -> Dict[str, Union[bool, int, float, None]]:
        if self.ws is None:
            raise RuntimeError("WebSocket is not connected")
        frames = build_all_sensor_query_frames()
        for frame in frames:
            await self.send_frame(frame)
        results: Dict[str, Union[bool, int, float, None]] = {}
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end and len(results) < len(SENSOR_DEVICES):
            remaining = end - loop.time()
            if remaining <= 0:
                break
            try:
                parsed = await asyncio.wait_for(self.recv_parsed(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if parsed is None:
                continue
            dev_id, value = parsed
            results[dev_id] = value
        return results

    async def set_actuator(self, device_id: str, value: Union[bool, int]) -> bool:
        if self.ws is None:
            raise RuntimeError("WebSocket is not connected")
        frame = get_actuator_control_frame(device_id, value)
        if frame is None:
            return False
        await self.send_frame(frame)
        return True


async def _main() -> None:
    client = GatewayWebSocketClient()
    await client.connect()
    try:
        snapshot = await client.query_all_sensors(timeout=5.0)
        for key in sorted(snapshot.keys()):
            print(key, "=", snapshot[key])
        await client.set_actuator("lightStrip", True)
        await asyncio.sleep(1.0)
        await client.set_actuator("lightStrip", False)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(_main())
