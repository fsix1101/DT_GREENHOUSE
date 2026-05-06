// 测试传感器数据解析器
const { crc16, parseFrame, parseSensorData } = require('./sensor_parser.js');

// 测试CRC16函数
console.log('测试CRC16函数:');
const testBuffer = Buffer.from([0xBB, 0x10, 0x03, 0x00, 0x01, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const crc = crc16(testBuffer);
console.log(`CRC16计算结果: 0x${crc.toString(16).toUpperCase()}`);
console.log('');

// 测试数据帧解析
console.log('测试数据帧解析:');

// 创建一个模拟的传感器数据帧（空气温度传感器）
const mockFrame = Buffer.from([
    0xBB, 0x10,           // 包头和长度
    0x03, 0x00, 0x02, 0x00, // 地址域：通信类，空气温度传感器，设备索引0
    0x03,                 // 功能码：定时上传
    0x03,                 // 数据类型：浮点型
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 数据域（6字节）
    0x00, 0x00            // CRC校验（这里先填0，后面计算）
]);

// 计算CRC并填充
const frameCrc = crc16(mockFrame.slice(0, 14));
mockFrame[14] = frameCrc & 0xFF;        // 低字节
mockFrame[15] = (frameCrc >> 8) & 0xFF; // 高字节

console.log(`模拟帧数据: ${Array.from(mockFrame).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

const parsedFrame = parseFrame(mockFrame);
if (parsedFrame) {
    console.log('帧解析成功:');
    console.log(`- 包头: 0x${parsedFrame.header.toString(16)}`);
    console.log(`- 长度: ${parsedFrame.length}`);
    console.log(`- 设备大类型: 0x${parsedFrame.address.category.toString(16)}`);
    console.log(`- 设备子类型: 0x${parsedFrame.address.subtype.toString(16)}`);
    console.log(`- 设备索引: ${parsedFrame.address.index}`);
    console.log(`- 功能码: 0x${parsedFrame.functionCode.toString(16)}`);
    console.log(`- 数据类型: 0x${parsedFrame.dataType.toString(16)}`);
    console.log(`- 数据域: ${Array.from(parsedFrame.data).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`- CRC校验: 0x${parsedFrame.crc.toString(16)}`);
    
    // 测试传感器数据解析
    console.log('\n测试传感器数据解析:');
    
    // 测试各种传感器类型
    const testCases = [
        {
            name: '空气温度传感器 (25.5°C)',
            frame: Buffer.from([
                0xBB, 0x10, 0x03, 0x00, 0x02, 0x00, 0x03, 0x03,
                0x00, 0x00, 0x00, 0x03, 0xE7, 0x00, 0x00, 0x00
            ])
        },
        {
            name: '空气湿度传感器 (65%)',
            frame: Buffer.from([
                0xBB, 0x10, 0x03, 0x00, 0x03, 0x00, 0x03, 0x02,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x00, 0x00
            ])
        },
        {
            name: '光照强度传感器 (1500 LUX)',
            frame: Buffer.from([
                0xBB, 0x10, 0x03, 0x00, 0x01, 0x00, 0x03, 0x02,
                0x00, 0x00, 0x00, 0x00, 0x05, 0xDC, 0x00, 0x00
            ])
        },
        {
            name: '人体感应传感器 (有人)',
            frame: Buffer.from([
                0xBB, 0x10, 0x01, 0x00, 0x03, 0x00, 0x03, 0x01,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00
            ])
        },
        {
            name: '雨雪传感器 (有雨雪)',
            frame: Buffer.from([
                0xBB, 0x10, 0x01, 0x00, 0x04, 0x00, 0x03, 0x01,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00
            ])
        }
    ];
    
    // 为每个测试用例计算CRC
    testCases.forEach(testCase => {
        const crc = crc16(testCase.frame.slice(0, 14));
        testCase.frame[14] = crc & 0xFF;
        testCase.frame[15] = (crc >> 8) & 0xFF;
        
        const frame = parseFrame(testCase.frame);
        if (frame) {
            const sensorData = parseSensorData(frame);
            console.log(`\n${testCase.name}:`);
            if (sensorData) {
                console.log(`  设备名称: ${sensorData.deviceName}`);
                console.log(`  传感器类型: ${sensorData.sensorType}`);
                console.log(`  数值: ${sensorData.value} ${sensorData.unit}`);
                console.log(`  数据类型: ${sensorData.dataType}`);
            } else {
                console.log('  解析失败');
            }
        }
    });
    
} else {
    console.log('帧解析失败');
}

console.log('\n测试完成！');