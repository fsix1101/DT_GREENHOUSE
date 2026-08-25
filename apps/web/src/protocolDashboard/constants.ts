import { DeviceMainType } from "../protocol/types.ts";

export type DeviceDef = {
  id: string;
  name: string;
  mainType: DeviceMainType;
  subType: number;
  index?: number;
  icon: string;
  unit?: string;
  max?: number;
  hideProgress?: boolean;
};

export type ActuatorControl =
  | {
      kind: "toggle";
      on: string;
      off: string;
    }
  | {
      kind: "trigger";
      fire: string;
    };

export type ActuatorDef = DeviceDef & {
  control: ActuatorControl;
};

export const SENSOR_DEVICES = [
  { id: "airTemp", name: "空气温度", mainType: DeviceMainType.COMMUNICATION, subType: 0x0002, index: 0x01, icon: "🌡️", unit: "°C" },
  { id: "airHumi", name: "空气湿度", mainType: DeviceMainType.COMMUNICATION, subType: 0x0003, index: 0x01, icon: "💧", unit: "%" },
  { id: "rainSnow", name: "雨雪", mainType: DeviceMainType.IO, subType: 0x0004, icon: "🌧️", unit: "Status" },
  { id: "light", name: "光照强度", mainType: DeviceMainType.COMMUNICATION, subType: 0x0001, index: 0x00, icon: "☀️", unit: "LUX" },
  { id: "pir", name: "人体感应", mainType: DeviceMainType.IO, subType: 0x0003, icon: "🚶‍♂️", unit: "Status" },
  { id: "soilTemp", name: "土壤温度", mainType: DeviceMainType.IO, subType: 0x000b, icon: "🌡️", unit: "°C" },
  { id: "soilHumi", name: "土壤湿度", mainType: DeviceMainType.IO, subType: 0x000a, icon: "💧", unit: "%" },
  { id: "co2", name: "二氧化碳", mainType: DeviceMainType.COMMUNICATION, subType: 0x000a, index: 0x01, icon: "🌬️", unit: "PPM", max: 1000 },
  { id: "ph", name: "PH值", mainType: DeviceMainType.COMMUNICATION, subType: 0x000f, index: 0x00, icon: "🧪", unit: "pH" },
  { id: "windSpeed", name: "风速", mainType: DeviceMainType.COMMUNICATION, subType: 0x000d, index: 0x00, icon: "🍃", unit: "m/s" },
  { id: "windDir", name: "风向", mainType: DeviceMainType.COMMUNICATION, subType: 0x000e, index: 0x00, icon: "🧭", unit: "°", hideProgress: true },
  { id: "smoke", name: "烟雾", mainType: DeviceMainType.IO, subType: 0x0001, icon: "🔥", unit: "Status" }
] satisfies DeviceDef[];

export const ACTUATOR_DEVICES = [
  {
    id: "exhaustFan",
    name: "换气扇",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "🌀",
    control: { kind: "toggle", on: "CC100300A200010400000000AAA9C0C3", off: "CC100300A200010400000000AAA80103" }
  },
  {
    id: "growLight",
    name: "植物生长灯",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "💡",
    control: { kind: "toggle", on: "CC100300A200010400000000AA9A80D6", off: "CC100300A200010400000000AA8A811A" }
  },
  {
    id: "humidifier",
    name: "加湿器",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "💧",
    control: { kind: "toggle", on: "CC100300A200010400000000AAA680C7", off: "CC100300A200010400000000AAA28104" }
  },
  {
    id: "heater",
    name: "加热器",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "🔥",
    control: { kind: "toggle", on: "CC100300A200010400000000AA6A8092", off: "CC100300A200010400000000AA2A8162" }
  },
  {
    id: "curtain",
    name: "智能窗帘",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "🪟",
    control: { kind: "toggle", on: "CC100300A2000104000000001AAAF502", off: "CC100300A2000104000000004AAAC902" }
  },
  {
    id: "pump",
    name: "水泵控制",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "🚿",
    control: { kind: "toggle", on: "CC100300A200010400000000A9AA8032", off: "CC100300A200010400000000A8AA81A2" }
  },
  {
    id: "alarmLight",
    name: "报警灯",
    mainType: DeviceMainType.COMMUNICATION,
    subType: 0x00a2,
    index: 0x00,
    icon: "🚨",
    control: { kind: "trigger", fire: "CC100300A200010400000000A2AA8702" }
  }
] satisfies ActuatorDef[];
