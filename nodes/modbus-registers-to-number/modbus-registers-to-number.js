module.exports = function(RED) {

function RegistersToNumber(config) {

RED.nodes.createNode(this,config);
var node = this;

node.on("input", function(msg) {

let regs = msg.payload;
let tipo = config.tipo;
let byteOrder = config.byteOrder;
let wordOrder = config.wordOrder;

if(!Array.isArray(regs)) return;

if(wordOrder === "swap" && regs.length > 1){
regs = regs.slice().reverse();
}

let buffer = Buffer.alloc(regs.length * 2);

for(let i=0;i<regs.length;i++){
buffer.writeUInt16BE(regs[i], i*2);
}

let valor;

switch(tipo){

case "INT16":
valor = buffer.readInt16BE(0);
break;

case "UINT16":
valor = buffer.readUInt16BE(0);
break;

case "INT32":
valor = byteOrder==="BE" ? buffer.readInt32BE(0) : buffer.readInt32LE(0);
break;

case "UINT32":
valor = byteOrder==="BE" ? buffer.readUInt32BE(0) : buffer.readUInt32LE(0);
break;

case "FLOAT32":
valor = byteOrder==="BE" ? buffer.readFloatBE(0) : buffer.readFloatLE(0);
break;

case "INT64":
valor = byteOrder==="BE" ? buffer.readBigInt64BE(0) : buffer.readBigInt64LE(0);
valor = Number(valor);
break;

case "UINT64":
valor = byteOrder==="BE" ? buffer.readBigUInt64BE(0) : buffer.readBigUInt64LE(0);
valor = Number(valor);
break;

case "FLOAT64":
valor = byteOrder==="BE" ? buffer.readDoubleBE(0) : buffer.readDoubleLE(0);
break;

}

msg.payload = valor;

node.send(msg);

});

}

RED.nodes.registerType("modbus-registers-to-number", RegistersToNumber);

}