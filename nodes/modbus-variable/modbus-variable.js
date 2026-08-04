module.exports = function(RED){

/*=========================================================
=            CATÁLOGO DE ALARMAS
=========================================================*/

const ALARMS={

  DEVICE_OFFLINE:{
    id:1,
    name:"DEVICE OFFLINE"
  },

  READ_TIMEOUT:{
    id:2,
    name:"READ TIMEOUT"
  },

  RTU_CRC_ERROR:{
    id:3,
    name:"RTU CRC ERROR"
  }

}

/*=========================================================
=            NODO MODBUS VARIABLE
=========================================================*/

function ModbusVariable(config){

RED.nodes.createNode(this,config)

let node=this

/*=========================================================
=            CONFIGURACIÓN DEL NODO
=========================================================*/

node.server=RED.nodes.getNode(config.server)
node.device_uuid=config.device_uuid
node.device_name=config.device_name
node.unitid=Number(config.unitid)

node.sequences=config.sequences||[]

/*=========================================================
=            REGISTRO CONTRA EL SERVIDOR MODBUS
=========================================================*/

// Registrarse hace que el servidor dispare su conexión inicial
// (y su reconexión automática interna) sin que nuestro nodo tenga
// que manejarla manualmente — igual que hacen "modbus read"/"flexgetter".

if(node.server){

    node.status({fill:"yellow",shape:"ring",text:"connecting"})

    node.server.on("mbconnected",function(){
        node.status({fill:"green",shape:"dot",text:"connected"})
    })

    node.server.on("mbclosed",function(){
        node.status({fill:"red",shape:"ring",text:"closed"})
    })

    node.server.on("mberror",function(){
        node.status({fill:"red",shape:"dot",text:"error"})
    })

    node.server.on("mbbroken",function(){
        node.status({fill:"red",shape:"ring",text:"broken"})
    })

    node.server.registerForModbus(node)

}else{
    node.status({fill:"red",shape:"dot",text:"no server configured"})
}

/*=========================================================
=            DESREGISTRO AL CERRAR EL NODO
=========================================================*/

node.on("close",function(done){

    if(node.server){
        node.server.deregisterForModbus(node, done)
    }else{
        done()
    }

})

/*=========================================================
=            LECTURA MODBUS VÍA EL SERVIDOR (NATIVA)
=========================================================*/

// En vez de llamar directo a node.server.client.readXxx(...), le
// pedimos la lectura AL SERVIDOR mediante el evento "readModbus"
// — el mismo mecanismo que usan los nodos oficiales "modbus read"
// y "flexgetter". El servidor internamente valida si está listo
// (isInactive()), encola el comando, y maneja toda la reconexión
// por su cuenta con sus propios temporizadores internos.
function modbusRead(fc,address,quantity,unitid){

    return new Promise(function(resolve,reject){

        if(!node.server){
            reject(new Error("No Modbus server configured"))
            return
        }

        let settled=false

        // Salvaguarda: en un caso límite interno de la librería
        // (cliente inexistente pero isInactive()===false) ninguno
        // de los callbacks se invoca. Evitamos quedarnos colgados
        // para siempre con este timeout de respaldo.
        let safetyTimeout=(node.server.clientTimeout||1000)+2000

        let timer=setTimeout(function(){
            if(settled) return
            settled=true
            reject(new Error("Modbus read timeout (sin respuesta del servidor)"))
        },safetyTimeout)

        let readMsg={

            payload:{
                fc:fc,
                unitid:unitid,
                address:address,
                quantity:quantity
            }

        }

        node.server.emit("readModbus",readMsg,function(result){

            if(settled) return
            settled=true
            clearTimeout(timer)
            resolve(result)

        },function(err){

            if(settled) return
            settled=true
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))

        })

    })

}

/*=========================================================
=            ESTADO DE ALARMAS
=========================================================*/

node.alarms={}

node.alarms[ALARMS.DEVICE_OFFLINE.id]=0
node.alarms[ALARMS.READ_TIMEOUT.id]=0
node.alarms[ALARMS.RTU_CRC_ERROR.id]=0

/*=========================================================
=            FUNCIONES DE ALARMAS
=========================================================*/

function emitAlarm(alarm,state,value=""){

    // Si el estado no cambió, no enviar nada
    if(node.alarms[alarm.id]===state){
        return null
    }

    // Actualizar estado interno
    node.alarms[alarm.id]=state

    // Construir mensaje de alarma
    return {

        payload:{

            device_uuid:node.device_uuid,
            device_name:node.device_name,

            alarm_id:alarm.id,
            alarm_name:alarm.name,

            state:state,

            value:value,
            unit:"",

            timestamp:Date.now()

        }

    }

}

/*=========================================================
=            FUNCIONES DE COMUNICACIÓN
=========================================================*/

function classifyError(err){

    let text=String(err.message || err).toUpperCase()

    // Timeout
    if(
        err.name === "TransactionTimedOutError" ||
        text.includes("TIMED OUT") ||
        text.includes("TIMEOUT")
    ){
        return ALARMS.READ_TIMEOUT
    }

    // CRC (Modbus RTU)
    if(text.includes("CRC")){
        return ALARMS.RTU_CRC_ERROR
    }

    // Error de comunicación (incluye el mensaje nativo de la librería
    // cuando isInactive() rechaza la lectura: "Client Not Ready To Read...")
    if(
        err.name==="PortNotOpenError" ||
        text.includes("ECONNREFUSED") ||
        text.includes("ECONNRESET") ||
        text.includes("EHOSTUNREACH") ||
        text.includes("ENETUNREACH") ||
        text.includes("PORT NOT OPEN") ||
        text.includes("NOT CONNECTED") ||
        text.includes("NO RESPONSE") ||
        text.includes("NOT READY")
    ){
        return ALARMS.DEVICE_OFFLINE
    }

    return null

}

/*=========================================================
=            ACTUALIZACIÓN DEL ESTADO DEL NODO
=========================================================*/

function updateStatus(cycle){

    let activeAlarms=[]

    if(node.alarms[ALARMS.DEVICE_OFFLINE.id]){
        activeAlarms.push("OFFLINE")
    }

    if(node.alarms[ALARMS.READ_TIMEOUT.id]){
        activeAlarms.push("TIMEOUT")
    }

    if(node.alarms[ALARMS.RTU_CRC_ERROR.id]){
        activeAlarms.push("CRC ERROR")
    }

    // Hay una o más alarmas activas
    if(activeAlarms.length){

        node.status({

            fill:"red",
            shape:"dot",
            text:activeAlarms.join(" | ")

        })

        return
    }

    // Hubo errores durante el ciclo
    if(cycle.variables_error>0){

        node.status({

            fill:"yellow",
            shape:"dot",
            text:`PARTIAL | ${cycle.variables_ok}/${cycle.variables_total}`

        })

        return
    }

    // Todo correcto
    node.status({

        fill:"green",
        shape:"dot",
        text:`OK | ${cycle.variables_ok}/${cycle.variables_total}`

    })

}

/*=========================================================
=            RECEPCIÓN DE MENSAJES
=========================================================*/

node.on("input",async function(msg){

let sequences=msg.sequences||node.sequences

/*=========================================================
=            CONTROL DEL CICLO DE ADQUISICIÓN
=========================================================*/

const cycle = {

    start_timestamp: Date.now(),

    variables_total: sequences.length,
    variables_ok: 0,
    variables_error: 0

}

/*=========================================================
=            VALIDACIÓN DEL SERVIDOR MODBUS
=========================================================*/

if(!node.server){
   node.error("No Modbus server configured",msg)

   cycle.variables_error=cycle.variables_total

   const endTs=Date.now()

   node.send([null,null,{

       payload:{

           type:"cycle_completed",

           device_uuid:node.device_uuid,
           device_name:node.device_name,

           start_timestamp:cycle.start_timestamp,
           end_timestamp:endTs,

           duration_ms:endTs-cycle.start_timestamp,

           variables_total:cycle.variables_total,
           variables_ok:0,
           variables_error:cycle.variables_total,

           status:"failed"

       }

   }])

   updateStatus(cycle)

   return
}

let unitid=msg.unitid||node.unitid

/*=========================================================
=            ESTADO DE LECTURA
=========================================================*/

node.status({

    fill:"green",
    shape:"ring",
    text:"READING"

})

/*=========================================================
=            EJECUCIÓN DE SECUENCIAS MODBUS
=========================================================*/

for(const seq of sequences){

try{

let fc=Number(seq.fc.replace("FC",""))
let address=Number(seq.address)
let quantity=Number(seq.quantity)

let result

/*=========================================================
=            LECTURA MODBUS (VÍA SERVIDOR)
=========================================================*/

result=await modbusRead(fc,address,quantity,unitid)

if(fc===1||fc===2){
    result.data=result.data.slice(0,quantity)
}

if(!result){

    cycle.variables_error++

    continue
}

/*=========================================================
=            RECUPERACIÓN DE ALARMAS DE COMUNICACIÓN
=========================================================*/

let alarmMsg

alarmMsg=emitAlarm(ALARMS.DEVICE_OFFLINE,0)
if(alarmMsg){
    node.send([null,alarmMsg,null])
}

alarmMsg=emitAlarm(ALARMS.READ_TIMEOUT,0)
if(alarmMsg){
    node.send([null,alarmMsg,null])
}

alarmMsg=emitAlarm(ALARMS.RTU_CRC_ERROR,0)
if(alarmMsg){
    node.send([null,alarmMsg,null])
}

/*=========================================================
=            CONVERSIÓN DEL VALOR LEÍDO
=========================================================*/

let value

if(fc===1||fc===2){

 value=result.data[0] ? 1 : 0

}else{

 value=convertRegisters(
  result.data,
  seq.datatype,
  seq.byteorder,
  seq.wordorder
 )

}

/*=========================================================
=            ESCALAMIENTO DEL VALOR
=========================================================*/

if(seq.scale){
 value=value*Number(seq.scale)
}

cycle.variables_ok++

/*=========================================================
=            ENVÍO DE VARIABLE
=========================================================*/

node.send([

{

  device_uuid:node.device_uuid,
  device_name:node.device_name,

  variable_name:seq.name,
  topic:seq.name,

  payload:value,
  unit:seq.unit||"",

  type:seq.type || "instantaneous",

  thresholds:seq.thresholds||[],

  responseBuffer:result.buffer,

  timestamp:Date.now()

},

null,

null

])
}
/*=========================================================
=            MANEJO DE ERRORES
=========================================================*/

catch(err){

    cycle.variables_error++

    let alarm=classifyError(err)

    if(alarm){

        let alarmMsg=emitAlarm(alarm,1)

        if(alarmMsg){
            node.send([null,alarmMsg,null])
        }

    }

    node.error(err,msg)

}
}

/*=========================================================
=            FIN DEL CICLO DE ADQUISICIÓN
=========================================================*/

const endTimestamp = Date.now()

let status = "ok"

if(cycle.variables_error === cycle.variables_total){
    status = "failed"
}
else if(cycle.variables_error > 0){
    status = "partial"
}

node.send([

    null,

    null,

    {

        payload:{

            type:"cycle_completed",

            device_uuid:node.device_uuid,
            device_name:node.device_name,

            start_timestamp:cycle.start_timestamp,
            end_timestamp:endTimestamp,

            duration_ms:endTimestamp-cycle.start_timestamp,

            variables_total:cycle.variables_total,
            variables_ok:cycle.variables_ok,
            variables_error:cycle.variables_error,

            status:status

        }

    }

])

updateStatus(cycle)

})

}

/*=========================================================
=            CONVERSIÓN DE REGISTROS MODBUS
=========================================================*/

function convertRegisters(data,datatype,byteorder,wordorder){

let regs=data.slice()

/*=========================================================
=            AJUSTE DEL ORDEN DE PALABRAS
=========================================================*/

if(wordorder==="swap" && regs.length>1){

 for(let i=0;i<regs.length;i+=2){

  if(regs[i+1]!==undefined){
   let tmp=regs[i]
   regs[i]=regs[i+1]
   regs[i+1]=tmp
  }

 }

}

/*=========================================================
=            CONSTRUCCIÓN DEL BUFFER
=========================================================*/

let buffer=Buffer.alloc(regs.length*2)

regs.forEach((reg,i)=>{

 if(byteorder==="BE"){
  buffer.writeUInt16BE(reg,i*2)
 }else{
  buffer.writeUInt16LE(reg,i*2)
 }

})

/*=========================================================
=            CONVERSIÓN SEGÚN EL TIPO DE DATO
=========================================================*/

switch(datatype){

case "int16":
 return byteorder==="BE"
  ?buffer.readInt16BE(0)
  :buffer.readInt16LE(0)

case "uint16":
 return byteorder==="BE"
  ?buffer.readUInt16BE(0)
  :buffer.readUInt16LE(0)

case "int32":
 return byteorder==="BE"
  ?buffer.readInt32BE(0)
  :buffer.readInt32LE(0)

case "uint32":
 return byteorder==="BE"
  ?buffer.readUInt32BE(0)
  :buffer.readUInt32LE(0)

case "float32":{
 let val=byteorder==="BE"
  ?buffer.readFloatBE(0)
  :buffer.readFloatLE(0)

 return Number(val.toFixed(2))
}

case "float64":{
 let val=byteorder==="BE"
  ?buffer.readDoubleBE(0)
  :buffer.readDoubleLE(0)

 return Number(val.toFixed(2))
}

case "int64":
 return (
  byteorder==="BE"
   ?buffer.readBigInt64BE(0)
   :buffer.readBigInt64LE(0)
 ).toString()

case "uint64":
 return (
  byteorder==="BE"
   ?buffer.readBigUInt64BE(0)
   :buffer.readBigUInt64LE(0)
 ).toString()

default:
 return regs

}

}

/*=========================================================
=            REGISTRO DEL NODO
=========================================================*/

RED.nodes.registerType("modbus-variable",ModbusVariable)

}
