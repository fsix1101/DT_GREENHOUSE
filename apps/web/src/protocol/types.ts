export enum Head {
  PC_TO_NODE = 0xcc,
  NODE_TO_PC = 0xbb
}

export enum DeviceMainType {
  IO = 0x01,
  POWER_CONTROL = 0x02,
  COMMUNICATION = 0x03,
  DEFAULT = 0xff
}

export enum Command {
  CONTROL = 0x01,
  QUERY = 0x02,
  REPORT = 0x03
}

export enum DataType {
  BOOL = 0x01,
  INT = 0x02,
  FLOAT = 0x03,
  ARRAY = 0x04,
  STRING = 0x05
}

export type Bytes = Uint8Array<ArrayBuffer>;

export interface ProtocolFrame {
  head: Head;
  length: number;
  addr: {
    mainType: DeviceMainType;
    subTypeHigh: number;
    subTypeLow: number;
    index: number;
  };
  cmd: Command;
  dataType: DataType;
  data: Bytes;
  verification: number;
}

export type UnpackResult = {
  frame: ProtocolFrame;
  crcOk: boolean;
};

