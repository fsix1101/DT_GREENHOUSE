import { DataType, type Bytes, type ProtocolFrame, type UnpackResult } from "./types.ts";

export function calculateCRC16Modbus(data: Bytes): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xffff;
}

export function packFrame(frame: Omit<ProtocolFrame, "verification" | "length">): Bytes {
  const buffer = new Uint8Array(16);
  buffer[0] = frame.head;
  buffer[1] = 0x10;
  buffer[2] = frame.addr.mainType;
  buffer[3] = frame.addr.subTypeHigh;
  buffer[4] = frame.addr.subTypeLow;
  buffer[5] = frame.addr.index;
  buffer[6] = frame.cmd;
  buffer[7] = frame.dataType;
  buffer.set(frame.data, 8);

  const crc = calculateCRC16Modbus(buffer.slice(0, 14));
  buffer[14] = crc & 0xff;
  buffer[15] = (crc >> 8) & 0xff;
  return buffer;
}

export function unpackFrame(buffer: Bytes): UnpackResult | null {
  if (buffer.length !== 16) return null;

  const verification = ((buffer[15] ?? 0) << 8) | (buffer[14] ?? 0);
  const calculated = calculateCRC16Modbus(buffer.slice(0, 14));

  const frame: ProtocolFrame = {
    head: buffer[0] as ProtocolFrame["head"],
    length: buffer[1] ?? 0,
    addr: {
      mainType: buffer[2] as ProtocolFrame["addr"]["mainType"],
      subTypeHigh: buffer[3] ?? 0,
      subTypeLow: buffer[4] ?? 0,
      index: buffer[5] ?? 0
    },
    cmd: buffer[6] as ProtocolFrame["cmd"],
    dataType: buffer[7] as ProtocolFrame["dataType"],
    data: buffer.slice(8, 14),
    verification
  };

  return { frame, crcOk: calculated === verification };
}

export function formatHex(buffer: Bytes): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export const createPayload = {
  bool(val: boolean): Bytes {
    const arr = new Uint8Array(6);
    arr[5] = val ? 1 : 0;
    return arr;
  },
  controlByte(val: number): Bytes {
    const arr = new Uint8Array(6);
    const v = Math.trunc(val);
    arr[5] = v & 0xff;
    return arr;
  },
  int(val: number): Bytes {
    const arr = new Uint8Array(6);
    const sign = val < 0 ? 1 : 0;
    const abs = Math.abs(Math.trunc(val));
    arr[0] = sign;
    const view = new DataView(arr.buffer);
    view.setUint32(1, abs >>> 0, false);
    return arr;
  },
  float(val: number): Bytes {
    const scaled = Math.round(val * 10000);
    const arr = new Uint8Array(6);
    const sign = scaled < 0 ? 1 : 0;
    const abs = Math.abs(scaled);
    arr[0] = sign;
    const view = new DataView(arr.buffer);
    view.setUint32(1, abs >>> 0, false);
    return arr;
  }
};

const SENSOR_TYPE_BY_MAIN: Record<number, Record<number, string>> = {
  0x01: {
    0x0001: "smoke",
    0x0003: "human",
    0x0004: "rainSnow",
    0x000a: "soilHumidity",
    0x000b: "soilTemperature"
  },
  0x03: {
    0x0001: "light",
    0x0002: "airTemperature",
    0x0003: "airHumidity",
    0x000a: "co2",
    0x000d: "windSpeed",
    0x000e: "windDirection",
    0x000f: "ph"
  }
};

export function decodeFrameValue(frame: ProtocolFrame): boolean | number | null {
  const subType = getSubType(frame);
  const sensorType = SENSOR_TYPE_BY_MAIN[frame.addr.mainType]?.[subType];

  if (frame.dataType === DataType.BOOL) {
    return (frame.data[5] ?? 0) === 1;
  }

  const d = frame.data;

  if (frame.dataType === DataType.INT) {
    if (sensorType === "light" || sensorType === "co2" || sensorType === "windDirection") {
      return ((d[4] ?? 0) << 8) | (d[5] ?? 0);
    }
    if (sensorType === "airHumidity" || sensorType === "soilHumidity") {
      return d[5] ?? 0;
    }

    const sign = (d[0] ?? 0) === 1 ? -1 : 1;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const raw = view.getUint32(1, false);
    if ((d[1] ?? 0) === 0xff && (d[2] ?? 0) === 0xff && (d[3] ?? 0) === 0xff && (d[4] ?? 0) === 0xff) {
      return null;
    }
    return sign * raw;
  }

  if (frame.dataType === DataType.FLOAT) {
    if (sensorType === "airTemperature" || sensorType === "soilTemperature") {
      if (d[1] === 0xff) {
        return null;
      }
      const raw =
        ((d[2] ?? 0) << 24) | ((d[3] ?? 0) << 16) | ((d[4] ?? 0) << 8) | (d[5] ?? 0);
      let value = raw / 10000;
      if (d[1] === 1) {
        value = -value;
      }
      return value;
    }

    if (sensorType === "windSpeed" || sensorType === "ph") {
      const raw =
        ((d[2] ?? 0) << 24) | ((d[3] ?? 0) << 16) | ((d[4] ?? 0) << 8) | (d[5] ?? 0);
      return raw / 10000;
    }

    const sign = (d[0] ?? 0) === 1 ? -1 : 1;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const raw = view.getUint32(1, false);
    if ((d[1] ?? 0) === 0xff && (d[2] ?? 0) === 0xff && (d[3] ?? 0) === 0xff && (d[4] ?? 0) === 0xff) {
      return null;
    }
    const value = sign * raw;
    return value / 10000;
  }

  return null;
}

export function getSubType(frame: ProtocolFrame): number {
  return ((frame.addr.subTypeHigh & 0xff) << 8) | (frame.addr.subTypeLow & 0xff);
}
