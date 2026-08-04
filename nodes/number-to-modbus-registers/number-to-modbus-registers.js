module.exports = function(RED) {

    function NumberToModbusRegisters(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.tipo = config.tipo || "INT16";
        node.byteOrder = config.byteOrder || "BE";     // BE | LE
        node.wordOrder = config.wordOrder || "normal"; // normal | swap

        node.on("input", function(msg) {

            const tipo = node.tipo.toUpperCase();
            const byteOrder = node.byteOrder.toUpperCase();
            const wordOrder = node.wordOrder.toLowerCase();

            let buffer;

            try {

                switch (tipo) {

                    case "INT16":
                        buffer = Buffer.alloc(2);
                        writeNumber16(buffer, msg.payload, byteOrder, true);
                        break;

                    case "UINT16":
                    case "WORD":
                        buffer = Buffer.alloc(2);
                        writeNumber16(buffer, msg.payload, byteOrder, false);
                        break;

                    case "INT32":
                        buffer = Buffer.alloc(4);
                        writeNumber32(buffer, msg.payload, byteOrder, true);
                        break;

                    case "UINT32":
                    case "DWORD":
                        buffer = Buffer.alloc(4);
                        writeNumber32(buffer, msg.payload, byteOrder, false);
                        break;

                    case "INT64":
                        buffer = Buffer.alloc(8);
                        writeBigInt64(buffer, msg.payload, byteOrder, true);
                        break;

                    case "UINT64":
                        buffer = Buffer.alloc(8);
                        writeBigInt64(buffer, msg.payload, byteOrder, false);
                        break;

                    case "FLOAT32":
                        buffer = Buffer.alloc(4);
                        let valFloat = Number(msg.payload);
                        if (isNaN(valFloat)) throw new Error("Payload is not numeric");
                        byteOrder === "BE"
                            ? buffer.writeFloatBE(valFloat, 0)
                            : buffer.writeFloatLE(valFloat, 0);
                        break;

                    case "FLOAT64":
                    case "DOUBLE":
                        buffer = Buffer.alloc(8);
                        let valDouble = Number(msg.payload);
                        if (isNaN(valDouble)) throw new Error("Payload is not numeric");
                        byteOrder === "BE"
                        ? buffer.writeDoubleBE(valDouble, 0)
                        : buffer.writeDoubleLE(valDouble, 0);
                        break;

                    default:
                        node.error("Unsupported data type", msg);
                        return;
                }

            } catch (err) {
                node.error("Conversion error: " + err.message, msg);
                return;
            }

            // Convert buffer to 16-bit Modbus registers
            let registros = [];

            for (let i = 0; i < buffer.length; i += 2) {
                registros.push(buffer.readUInt16BE(i));
            }

            // Word swap
            if (wordOrder === "swap" && registros.length > 1) {
                for (let i = 0; i < registros.length; i += 2) {
                    if (registros[i + 1] !== undefined) {
                        [registros[i], registros[i + 1]] =
                        [registros[i + 1], registros[i]];
                    }
                }
            }

            msg.payload = registros;
            msg.tipo = tipo;
            msg.byteOrder = byteOrder;
            msg.wordOrder = wordOrder;

            node.send(msg);
        });


        // ===== Helpers =====

        function writeNumber16(buffer, payload, byteOrder, signed) {
            let val = Number(payload);
            if (isNaN(val)) throw new Error("Payload is not numeric");

            if (signed) {
                byteOrder === "BE"
                    ? buffer.writeInt16BE(val, 0)
                    : buffer.writeInt16LE(val, 0);
            } else {
                byteOrder === "BE"
                    ? buffer.writeUInt16BE(val, 0)
                    : buffer.writeUInt16LE(val, 0);
            }
        }

        function writeNumber32(buffer, payload, byteOrder, signed) {
            let val = Number(payload);
            if (isNaN(val)) throw new Error("Payload is not numeric");

            if (signed) {
                byteOrder === "BE"
                    ? buffer.writeInt32BE(val, 0)
                    : buffer.writeInt32LE(val, 0);
            } else {
                byteOrder === "BE"
                    ? buffer.writeUInt32BE(val, 0)
                    : buffer.writeUInt32LE(val, 0);
            }
        }

        function writeBigInt64(buffer, payload, byteOrder, signed) {
            let val;
            try {
                val = BigInt(payload);
            } catch {
                throw new Error("Payload is not valid BigInt");
            }

            if (signed) {
                byteOrder === "BE"
                    ? buffer.writeBigInt64BE(val, 0)
                    : buffer.writeBigInt64LE(val, 0);
            } else {
                byteOrder === "BE"
                    ? buffer.writeBigUInt64BE(val, 0)
                    : buffer.writeBigUInt64LE(val, 0);
            }
        }

    }

    RED.nodes.registerType("number-to-modbus-registers", NumberToModbusRegisters);
};