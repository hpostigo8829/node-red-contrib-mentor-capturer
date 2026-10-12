module.exports = function(RED){

const naturaleza=require("../../resources/naturaleza-variable")

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
=            IDENTIFICADORES (spec 007)
=========================================================*/

// RN1/RN2: device_uuid es obligatorio y uuid v4 en todos los entornos, sin
// valor por defecto. Sin uno válido el nodo no lee nada (E4): ni siquiera
// arranca su temporizador (más abajo).
node.device_uuidValido=naturaleza.esUuidV4(node.device_uuid)

if(!node.device_uuidValido){
    node.error(`device_uuid "${node.device_uuid}" no es un uuid v4 válido (o falta): el nodo no leerá ninguna variable`)
}

// Una secuencia sin variable_uuid válido no se lee (E1/E2); se avisa una sola
// vez por nombre, no en cada ciclo.
node.variableSinUuidAvisada={}

/*=========================================================
=            CADENCIA PROPIA DEL DISPOSITIVO (parche 003)
=========================================================*/

// Milisegundos entre el fin de un ciclo y el arranque del siguiente. Ausente o
// inválido (<=0) en un flujo existente = 1000 (E3 de la spec 006): ningún flujo
// anterior a esta spec cambia de comportamiento sin editarlo, salvo por empezar
// a ciclar solo en vez de depender de un `inject` externo.
node.period_ms=Number(config.period_ms)>0 ? Number(config.period_ms) : 1000

// Ciclos fallidos seguidos para abrir una alarma de comunicación (spec 010, D8).
// Un ciclo fallido es uno en el que se intentó leer y TODAS las lecturas fallaron
// (el status "failed" de la salida 3, con al menos una variable). Ausente o
// inválido (no entero >=1) = 3; con 1 se abre al primer ciclo fallido.
node.failed_cycles=(Number.isInteger(Number(config.failed_cycles)) && Number(config.failed_cycles)>=1)
    ? Number(config.failed_cycles)
    : 3

node.rachaFallida=0
node.rachaInicio=null
node.claseFallida=null

node.timerHandle=null
node.cycleRunning=false
node.closed=false
node.discardWarnedThisCycle=false
node.delayWarned=false

/*=========================================================
=            REGISTRO CONTRA EL SERVIDOR MODBUS
=========================================================*/

// Registrarse hace que el servidor dispare su conexión inicial
// (y su reconexión automática interna) sin que nuestro nodo tenga
// que manejarla manualmente — igual que hacen "modbus read"/"flexgetter".

if(node.server){

    node.status({fill:"yellow",shape:"ring",text:RED._("modbus-variable.status.connecting")})

    node.server.on("mbconnected",function(){
        node.status({fill:"green",shape:"dot",text:RED._("modbus-variable.status.connected")})
    })

    node.server.on("mbclosed",function(){
        node.status({fill:"red",shape:"ring",text:RED._("modbus-variable.status.closed")})
    })

    node.server.on("mberror",function(){
        node.status({fill:"red",shape:"dot",text:RED._("modbus-variable.status.error")})
    })

    node.server.on("mbbroken",function(){
        node.status({fill:"red",shape:"ring",text:RED._("modbus-variable.status.broken")})
    })

    node.server.registerForModbus(node)

}else{
    node.status({fill:"red",shape:"dot",text:RED._("modbus-variable.status.noServer")})
}

if(!node.device_uuidValido){
    node.status({fill:"red",shape:"dot",text:RED._("modbus-variable.status.invalidDeviceUuid")})
}

/*=========================================================
=            DESREGISTRO AL CERRAR EL NODO
=========================================================*/

node.on("close",function(done){

    node.closed=true

    // Cancela el temporizador pendiente (CA5): ni un ciclo en vuelo sigue
    // leyendo un servidor que ya no existe, ni queda un `setTimeout` disparando
    // tras el cierre.
    if(node.timerHandle){
        clearTimeout(node.timerHandle)
        node.timerHandle=null
    }

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

/*=========================================================
=            ESTADO DE LOS CONTADORES ACUMULADOS
=========================================================*/

// Un conversor por variable con counter_mode "running_total". Vive en memoria:
// al redesplegar, la primera lectura vuelve a no tener valor previo.
node.conversores={}

// Configuración ya avisada, para no repetir el mismo error en cada ciclo.
node.configInvalida={}

// Configuración válida pero incompleta (un contador de producción sin su umbral
// de conteo cero). Se avisa una vez y la variable se emite igual.
node.configIncompleta={}

node.alarms[ALARMS.DEVICE_OFFLINE.id]=0
node.alarms[ALARMS.READ_TIMEOUT.id]=0
node.alarms[ALARMS.RTU_CRC_ERROR.id]=0

/*=========================================================
=            FUNCIONES DE ALARMAS
=========================================================*/

// timestamp es el instante real del cambio (ms): al abrir, el del primer ciclo
// fallido de la racha (spec 010); al cerrar, el de la primera lectura buena.
function emitAlarm(alarm,state,value="",timestamp=Date.now()){

    // Si el estado no cambió, no enviar nada
    if(node.alarms[alarm.id]===state){
        return null
    }

    // Actualizar estado interno
    node.alarms[alarm.id]=state

    // Construir mensaje de alarma (formato común de las tres fuentes, C-01 v3).
    // Cada clase de error es una de las alarmas reservadas del catálogo
    // modbus-variable; la severidad la pone el consumidor por el alarm_uuid.
    return {

        payload:{

            device_uuid:node.device_uuid,
            device_name:node.device_name,

            catalog:"modbus-variable",
            alarm_uuid:naturaleza.alarmaReservada("modbus-variable",alarm.id).alarm_uuid,
            alarm_name:alarm.name,

            state:state,

            value:value,
            unit:"",

            timestamp:timestamp

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

    // E1: al menos una secuencia sin variable_uuid válido, o sin un uso válido.
    // No leerla es un problema de configuración, no un fallo de comunicación: se
    // marca en rojo aparte de las alarmas y del recuento ok/error (CA7).
    if(cycle.variables_omitted>0){

        let motivos=[]

        if(cycle.variables_sin_uuid>0) motivos.push(RED._("modbus-variable.status.noUuid",{count:cycle.variables_sin_uuid}))
        if(cycle.variables_sin_uso>0) motivos.push(RED._("modbus-variable.status.noUsage",{count:cycle.variables_sin_uso}))

        node.status({

            fill:"red",
            shape:"dot",
            text:`${motivos.join(" | ")} | ${cycle.variables_ok}/${cycle.variables_total}`

        })

        return
    }

    // Hubo errores durante el ciclo
    if(cycle.variables_error>0){

        node.status({

            fill:"yellow",
            shape:"dot",
            text:`${RED._("modbus-variable.status.partial")} | ${cycle.variables_ok}/${cycle.variables_total}`

        })

        return
    }

    // Todo correcto
    node.status({

        fill:"green",
        shape:"dot",
        text:`${RED._("modbus-variable.status.ok")} | ${cycle.variables_ok}/${cycle.variables_total}`

    })

}

/*=========================================================
=            RECEPCIÓN DE MENSAJES
=========================================================*/

/*=========================================================
=            CICLO DE ADQUISICIÓN (temporizador propio o input)
=========================================================*/

// RN1: nunca dos ciclos del mismo nodo a la vez, sea cual sea el disparador
// (temporizador interno o `input` externo, E2). `runCycle` es el único punto
// que ejecuta un ciclo completo; el `input` y el temporizador solo deciden
// cuándo llamarlo, nunca lo hacen en paralelo.
async function runCycle(msg){

// E4/RN2: sin un device_uuid válido el nodo no lee nada. El aviso ya se dio
// una vez al construir el nodo (más arriba); aquí solo se corta el ciclo.
if(!node.device_uuidValido){
    return
}

node.cycleRunning=true
node.discardWarnedThisCycle=false

let sequencesConfiguradas=(msg&&msg.sequences)||node.sequences

/*=========================================================
=            IDENTIFICADORES DE VARIABLE (spec 007)
=========================================================*/

// E1/E2: una secuencia sin variable_uuid válido no se lee. Se separa antes de
// tocar el equipo, para que ni siquiera cuente como intento fallido.
let sequences=[]
let variablesSinUuid=0
let variablesSinUso=0

for(const seq of sequencesConfiguradas){

    if(!naturaleza.esUuidV4(seq.variable_uuid)){

        variablesSinUuid++

        if(!node.variableSinUuidAvisada[seq.name]){
            node.variableSinUuidAvisada[seq.name]=true
            node.error(`${seq.name}: variable_uuid ausente o inválido; la secuencia no se lee`)
        }

        continue

    }

    // Uso de la variable (spec 009): sin un uso válido no se sabe cómo resumirla
    // ni en qué cálculo entra, así que no se lee ni se emite. Una vez por nombre.
    let errores=naturaleza.validarVariable(seq)

    if(errores.length){

        variablesSinUso++

        if(!node.configInvalida[seq.name]){
            node.configInvalida[seq.name]=true
            node.error(`${seq.name}: ${errores.join("; ")}. La secuencia no se lee`)
        }

        continue

    }

    sequences.push(seq)

}

let variablesOmitidas=variablesSinUuid+variablesSinUso

/*=========================================================
=            CONTROL DEL CICLO DE ADQUISICIÓN
=========================================================*/

const cycle = {

    start_timestamp: Date.now(),

    variables_total: sequences.length,
    variables_ok: 0,
    variables_error: 0,
    variables_omitted: variablesOmitidas,
    variables_sin_uuid: variablesSinUuid,
    variables_sin_uso: variablesSinUso

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

   node.cycleRunning=false

   return
}

let unitid=(msg&&msg.unitid)||node.unitid

/*=========================================================
=            ESTADO DE LECTURA
=========================================================*/

node.status({

    fill:"green",
    shape:"ring",
    text:RED._("modbus-variable.status.reading")

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
=            NATURALEZA DE LA VARIABLE
=========================================================*/

// Una configuración inválida no llega hasta aquí: se separó antes de leer.
let descripcion=naturaleza.describirVariable(seq)

// Lo que falta sin invalidar la declaración: se avisa, pero la variable se emite
// entera. Degradarla aquí sería peor que el problema — un contador de producción
// dejaría de convertir su total corrido y el conteo saldría disparado.
if(descripcion.avisos && descripcion.avisos.length && !node.configIncompleta[seq.name]){

 node.configIncompleta[seq.name]=true

 node.warn(`${seq.name}: ${descripcion.avisos.join("; ")}`)

}

/*=========================================================
=            TOTAL CORRIDO -> INCREMENTO
=========================================================*/

if(descripcion.convierteTotalCorrido){

 let conversor=node.conversores[seq.name]

 if(!conversor){
  conversor=node.conversores[seq.name]=naturaleza.crearConversorTotalCorrido()
 }

 let lectura=value
 let convertida=conversor.convertir(lectura)

 if(convertida.motivo==="reinicio"){
  node.warn(`${seq.name}: la lectura bajó a ${lectura}; se toma como reinicio del contador`)
 }

 // Primera lectura tras arrancar, o lectura no numérica: no hay incremento que
 // emitir. Un 0 abriría un tramo de conteo cero que no ocurrió.
 if(convertida.valor===null) continue

 value=convertida.valor

}

/*=========================================================
=            ENVÍO DE VARIABLE
=========================================================*/

node.send([

{

  device_uuid:node.device_uuid,
  device_name:node.device_name,

  variable_uuid:seq.variable_uuid,
  variable_name:seq.name,
  topic:seq.name,

  payload:value,
  unit:seq.unit||"",

  ...descripcion.campos,

  thresholds:naturaleza.umbralesParaMensaje(seq.thresholds),

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

    // La clase del último error reconocible del ciclo; la alarma, si procede, se
    // abre al terminar el ciclo (más abajo), no en el primer fallo.
    let alarm=classifyError(err)

    if(alarm){
        cycle.claseError=alarm
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

/*=========================================================
=            ALARMAS DE COMUNICACIÓN (spec 010, D8)
=========================================================*/

// Un ciclo fallido: se intentó leer al menos una variable y todas fallaron. Uno
// parcial (alguna lectura buena) no cuenta y reinicia la racha: el equipo
// contesta. Sin variables que leer (todas omitidas) no se sabe nada y la racha
// no se toca. La alarma de la clase del último error reconocible se abre al
// terminar el N-ésimo ciclo fallido seguido, con el instante en que empezó el
// primero; el cierre sigue siendo la primera lectura buena (más arriba).
if(cycle.variables_total>0){

    if(status==="failed"){

        if(node.rachaFallida===0){
            node.rachaInicio=cycle.start_timestamp
        }

        node.rachaFallida++

        if(cycle.claseError){
            node.claseFallida=cycle.claseError
        }

        if(node.rachaFallida>=node.failed_cycles && node.claseFallida){

            let alarmMsg=emitAlarm(node.claseFallida,1,"",node.rachaInicio)

            if(alarmMsg){
                node.send([null,alarmMsg,null])
            }

        }

    }else{

        node.rachaFallida=0
        node.rachaInicio=null
        node.claseFallida=null

    }

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

node.cycleRunning=false

/*=========================================================
=            REPROGRAMACIÓN DEL SIGUIENTE CICLO (RN2)
=========================================================*/

// Un retraso (ciclo más largo que el periodo) se avisa una vez por episodio
// (RN3), no en cada ciclo mientras dure.
let duracion=endTimestamp-cycle.start_timestamp

if(duracion>node.period_ms){

    if(!node.delayWarned){
        node.delayWarned=true
        node.warn(`${node.device_uuid}: el ciclo tardó ${duracion}ms, más que el periodo configurado de ${node.period_ms}ms`)
    }

}else{
    node.delayWarned=false
}

// Si el ciclo tardó más que el periodo, el siguiente arranca en cuanto termina
// éste (delay 0), sin esperar al próximo múltiplo del periodo (CA4/RN2). Si
// no tocó al servidor (se cerró el nodo mientras el ciclo estaba en curso), no
// se reprograma nada más.
if(node.server && !node.closed){
    scheduleNext(Math.max(0,node.period_ms-duracion))
}

} // fin de runCycle

/*=========================================================
=            TEMPORIZADOR PROPIO POR DISPOSITIVO (parche 003)
=========================================================*/

function scheduleNext(delayMs){

    if(node.closed) return

    node.timerHandle=setTimeout(function(){
        node.timerHandle=null
        triggerCycle()
    },delayMs)

    // No debe ser lo único que mantenga vivo el proceso: un doble de pruebas que
    // instancia el nodo y nunca lo cierra no debe colgar el runner para siempre.
    if(typeof node.timerHandle.unref==="function"){
        node.timerHandle.unref()
    }

}

function triggerCycle(){

    // No debería darse (el temporizador solo se reprograma después de que el
    // ciclo anterior termina), pero se reintenta en vez de perder el ciclo si
    // ocurriera de todas formas.
    if(node.cycleRunning){
        scheduleNext(node.period_ms)
        return
    }

    runCycle(null)

}

node.on("input",function(msg){

    if(node.cycleRunning){

        // Un `input` externo (flujo de laboratorio, p. ej. un `inject` manual)
        // mientras el temporizador ya tiene un ciclo en curso: se descarta sin
        // solapar (RN1, E2). Un aviso por episodio, no uno por cada input.
        if(!node.discardWarnedThisCycle){
            node.discardWarnedThisCycle=true
            node.warn(`${node.device_uuid}: ciclo en curso, se descarta un input externo`)
        }

        return
    }

    runCycle(msg)

})

// Arranca solo si hay servidor configurado y un device_uuid válido: sin
// servidor no hay qué leer, y sin device_uuid el nodo no debe leer nada (E4).
// El primer `input` (si llega) ya lo dirá con su propio error (CA2).
if(node.server && node.device_uuidValido){
    scheduleNext(node.period_ms)
}

} // fin de ModbusVariable

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
