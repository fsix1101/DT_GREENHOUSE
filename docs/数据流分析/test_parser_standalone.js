// 独立的测试脚本，包含所有需要的函数

// CRC16校验函数（多项式0xA001，初值0xFFFF）
function crc16(buffer) {
    let crc = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc = crc >> 1;
            }
        }
    }
    return crc;
}

// 设备大类型映射
const DEVICE_CATEGORY = {
    0x01: 'IO类',
    0x02: '功率控制类',
    0x03: '通信类',
    0xFF: '缺省类'
};

// 设备子类型映射
const DEVICE_SUBTYPE = {
    0x0001: { name: '火灾/烟雾传感器', type: 'smoke', dataType: 0x01 },
    0x0003: { name: '人体感应', type: 'human', dataType: 0x01 },
    0x0004: { name: '雨雪传感器', type: 'rain_snow', dataType: 0x01 },
    0x000A: { name: '土壤湿度传感器', type: 'soil_humidity', dataType: 0x02 },
    0x000B: { name: '土壤温度传感器', type: 'soil_temperature', dataType: 0x03 },
    0x0001: { name: '光照强度传感器', type: 'light_intensity', dataType: 0x02 },
    0x0002: { name: '空气温度传感器', type: 'air_temperature', dataType: 0x03 },
    0x0003: { name: '空气湿度传感器', type: 'air_humidity', dataType: 0x02 },
    0x000A: { name: '二氧化碳传感器', type: 'co2', dataType: 0x02 },
    0x000D: { name: '风速传感器', type: 'wind_speed', dataType: 0x03 },
    0x000E: { name: '风向传感器', type: 'wind_direction', dataType: 0x02 },
    0x000F: { name: 'PH计', type: 'ph', dataType: 0x03 }
};

// 数据类型映射
const DATA_TYPE = {
    0x01: '布尔型',
    0x02: '整型',
    0x03: '浮点型',
    0x04: '数组型',
    0x05: '字符串型'
};

// 功能码映射
const FUNCTION_CODE = {
    0x01: '响应控制命令回传',
    0x02: '响应查询设备信息',
    0x03: '定时上传设备数据'
};

// 解析数据帧
function parseFrame(buffer) {
    if (buffer.length < 16) {
        return null;
    }
    
    if (buffer[0] !== 0xBB) {
        return null;
    }
    
    if (buffer[1] !== 16) {
        return null;
    }
    
    const frame = {
        header: buffer[0],
        length: buffer[1],
        address: {
            category: buffer[2],
            subtype: (buffer[3] << 8) | buffer[4],
            index: buffer[5]
        },
        functionCode: buffer[6],
        dataType: buffer[7],
        data: buffer.slice(8, 14),
        crc: (buffer[15] << 8) | buffer[14]
    };
    
    const calcCrc = crc16(buffer.slice(0, 14));
    if (calcCrc !== frame.crc) {
        console.error(`CRC校验失败: 计算值=${calcCrc.toString(16)}, 接收值=${frame.crc.toString(16)}`);
        return null;
    }
    
    return frame;
}

// 解析传感器数据
function parseSensorData(frame) {
    if (!frame || frame.functionCode !== 0x03) {
        return null;
    }
    
    const category = frame.address.category;
    const subtype = frame.address.subtype;
    const dataType = frame.dataType;
    const data = frame.data;
    
    const deviceInfo = DEVICE_SUBTYPE[subtype];
    if (!deviceInfo) {
        return {
            timestamp: new Date().toISOString(),
            deviceIndex: frame.address.index,
            category: DEVICE_CATEGORY[category] || `未知类别(0x${category.toString(16)})`,
            subtype: `未知子类型(0x${subtype.toString(16)})`,
            rawData: Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '),
            error: '未知设备类型'
        };
    }
    
    let value = null;
    let unit = '';
    
    switch (dataType) {
        case 0x01: // 布尔型
            value = data[5] === 1;
            unit = '状态';
            break;
            
        case 0x02: // 整型
            if (deviceInfo.type === 'light_intensity') {
                value = (data[4] << 8) | data[5];
                unit = 'LUX';
            } else if (deviceInfo.type === 'air_humidity') {
                value = data[5];
                unit = '%';
            } else if (deviceInfo.type === 'soil_humidity') {
                value = data[5];
                unit = '%';
            } else if (deviceInfo.type === 'co2') {
                value = (data[4] << 8) | data[5];
                unit = 'PPM';
            } else if (deviceInfo.type === 'wind_direction') {
                value = (data[4] << 8) | data[5];
                unit = '度';
            }
            break;
            
        case 0x03: // 浮点型
            if (deviceInfo.type === 'air_temperature') {
                if (data[1] === 0xFF) {
                    value = null;
                    unit = '损坏/未接';
                } else {
                    const tempValue = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
                    value = tempValue / 10000;
                    if (data[1] === 1) {
                        value = -value;
                    }
                    unit = '°C';
                }
            } else if (deviceInfo.type === 'soil_temperature') {
                if (data[1] === 0xFF) {
                    value = null;
                    unit = '损坏/未接';
                } else {
                    const tempValue = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
                    value = tempValue / 10000;
                    if (data[1] === 1) {
                        value = -value;
                    }
                    unit = '°C';
                }
            } else if (deviceInfo.type === 'wind_speed') {
                const speedValue = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
                value = speedValue / 10000;
                unit = 'm/s';
            } else if (deviceInfo.type === 'ph') {
                const phValue = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
                value = phValue / 10000;
                unit = 'PH';
            }
            break;
    }
    
    return {
        timestamp: new Date().toISOString(),
        deviceIndex: frame.address.index,
        category: DEVICE_CATEGORY[category] || `未知类别(0x${category.toString(16)})`,
        deviceName: deviceInfo.name,
        sensorType: deviceInfo.type,
        value: value,
        unit: unit,
        dataType: DATA_TYPE[dataType] || `未知类型(0x${dataType.toString(16)})`,
        function: FUNCTION_CODE[frame.functionCode] || `未知功能(0x${frame.functionCode.toString(16)})`,
        rawData: Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ')
    };
}

// 测试CRC16函数
console.log('测试CRC16函数:');
const testBuffer = Buffer.from([0xBB, 0x10, 0x03, 0x00, 0x01, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const crc = crc16(testBuffer);
console.log(`CRC16计算结果: 0x${crc.toString(16).toUpperCase()}`);
console.log('');

// 测试数据帧解析
console.log('测试数据帧解析:');

// 测试各种传感器类型
const testCases = [
    {
        name: '空气温度传感器 (25.5°C)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x02, 0x00, 0x03, 0x03,
            0x00, 0x00, 0x00, 0x03, 0xE7, 0x00, 0x00, 0x00
        ]),
        expectedValue: 25.5
    },
    {
        name: '空气湿度传感器 (65%)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x03, 0x00, 0x03, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x00, 0x00
        ]),
        expectedValue: 65
    },
    {
        name: '光照强度传感器 (1500 LUX)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x01, 0x00, 0x03, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x05, 0xDC, 0x00, 0x00
        ]),
        expectedValue: 1500
    },
    {
        name: '人体感应传感器 (有人)',
        frame: Buffer.from([
            0xBB, 0x10, 0x01, 0x00, 0x03, 0x00, 0x03, 0x01,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00
        ]),
        expectedValue: true
    },
    {
        name: '雨雪传感器 (有雨雪)',
        frame: Buffer.from([
            0xBB, 0x10, 0x01, 0x00, 0x04, 0x00, 0x03, 0x01,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00
        ]),
        expectedValue: true
    },
    {
        name: '土壤湿度传感器 (45%)',
        frame: Buffer.from([
            0xBB, 0x10, 0x01, 0x00, 0x0A, 0x00, 0x03, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x2D, 0x00, 0x00
        ]),
        expectedValue: 45
    },
    {
        name: '二氧化碳传感器 (800 PPM)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x0A, 0x00, 0x03, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x03, 0x20, 0x00, 0x00
        ]),
        expectedValue: 800
    },
    {
        name: '风速传感器 (3.5 m/s)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x0D, 0x00, 0x03, 0x03,
            0x00, 0x00, 0x00, 0x00, 0x88, 0x94, 0x00, 0x00
        ]),
        expectedValue: 3.5
    },
    {
        name: '风向传感器 (45度)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x0E, 0x00, 0x03, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x2D, 0x00, 0x00
        ]),
        expectedValue: 45
    },
    {
        name: 'PH计 (6.8 PH)',
        frame: Buffer.from([
            0xBB, 0x10, 0x03, 0x00, 0x0F, 0x00, 0x03, 0x03,
            0x00, 0x00, 0x00, 0x01, 0x09, 0x80, 0x00, 0x00
        ]),
        expectedValue: 6.8
    }
];

// 为每个测试用例计算CRC并测试
let passed = 0;
let failed = 0;

testCases.forEach((testCase, index) => {
    console.log(`\n${index + 1}. ${testCase.name}:`);
    console.log(`   原始数据: ${Array.from(testCase.frame.slice(0, 14)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    
    // 计算CRC
    const crc = crc16(testCase.frame.slice(0, 14));
    const frameWithCrc = Buffer.concat([
        testCase.frame.slice(0, 14),
        Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])
    ]);
    
    console.log(`   带CRC数据: ${Array.from(frameWithCrc).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    
    // 解析帧
    const frame = parseFrame(frameWithCrc);
    if (!frame) {
        console.log('   ❌ 帧解析失败');
        failed++;
        return;
    }
    
    // 解析传感器数据
    const sensorData = parseSensorData(frame);
    if (!sensorData) {
        console.log('   ❌ 传感器数据解析失败');
        failed++;
        return;
    }
    
    console.log(`   设备名称: ${sensorData.deviceName}`);
    console.log(`   解析结果: ${sensorData.value} ${sensorData.unit}`);
    console.log(`   数据类型: ${sensorData.dataType}`);
    
    // 检查结果
    if (sensorData.value === testCase.expectedValue) {
        console.log('   ✅ 测试通过');
        passed++;
    } else {
        console.log(`   ❌ 测试失败: 期望 ${testCase.expectedValue}, 实际 ${sensorData.value}`);
        failed++;
    }
});

console.log('\n' + '='.repeat(50));
console.log(`测试总结: 通过 ${passed} 个, 失败 ${failed} 个`);
console.log('='.repeat(50));

if (failed === 0) {
    console.log('🎉 所有测试通过！');
} else {
    console.log('⚠️  有测试失败，请检查代码。');
}