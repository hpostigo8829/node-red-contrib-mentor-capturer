module.exports = function(RED){

const naturaleza=require("../../resources/naturaleza-variable")
const alarmas=require("../../resources/alarmas")

function DeviceReporter(config){

RED.nodes.createNode(this,config)

let node=this

// CA8 (spec 007): descarta con un aviso, una vez por clave, un mensaje sin
// device_uuid o variable_uuid válido; y un variable_uuid repetido con otro
// nombre en el mismo despliegue (RN5, CA10).
node.avisosDescartados={}
node.avisosDuplicado={}

let interval=Number(config.interval)||60
let unit=config.unit||"seconds"

let multiplier={
 seconds:1000,
 minutes:60000,
 hours:3600000
}

let interval_ms=interval*(multiplier[unit]||1000)

let devices={}

// Spec 008: alarmas por dispositivo, las que emiten la salida 2 de
// modbus-variable, la de module-production y alarm-generator. state 1 abre el
// tramo, state 0 lo cierra, y el paquete las declara en alarms[]. Spec 010: la
// clave es (device_uuid, catalog, alarm_uuid), la misma en los dos reporters.
let registro_alarmas=alarmas.crearRegistroDeAlarmas()
node.avisosAlarma={}

let start_range=Math.floor(Date.now()/1000)

function getStdDev(sum,sum_sq,count){

 if(count<=1) return 0
 let mean=sum/count
 let variance=(sum_sq/count)-(mean*mean)

 // Por error de redondeo de punto flotante, cuando la varianza real es ~0
 // (valores muy similares entre si, comun en rangos de umbral estables),
 // "variance" puede salir levemente negativo y romper Math.sqrt (-> NaN).
 // Se acota a 0 como piso.
 if(variance<0) variance=0

 return Math.sqrt(variance)

}

function round2(n){

 if(n===null||n===undefined||isNaN(n)) return n
 return Math.round((n+Number.EPSILON)*100)/100

}

// Vocabulario único de umbrales (gt, gte, eq, lte, lt, between), el mismo que
// evalúa module-production: vive en resources/naturaleza-variable.js.
function checkCondition(value,thr){
 return naturaleza.evaluarUmbral(value,thr)
}

function registrarAlarma(p){

 let errores=alarmas.validarAlarma(p)

 if(errores.length){

  let claveAviso=(p&&p.device_uuid)+"|"+(p&&p.catalog)+"|"+(p&&p.alarm_uuid)

  if(!node.avisosAlarma[claveAviso]){
   node.avisosAlarma[claveAviso]=true
   node.error(`alarma descartada: ${errores.join("; ")}`)
  }

  return

 }

 let a=alarmas.normalizarAlarma(p)

 // El dispositivo entra en el informe aunque aún no tenga muestras: una alarma
 // de comunicación llega precisamente cuando no hay lectura.
 if(!devices[a.device_uuid]){
  devices[a.device_uuid]={
   device_uuid:a.device_uuid,
   device_name:a.device_name||"",
   variables:{}
  }
 }
 else if(!devices[a.device_uuid].device_name && a.device_name){
  devices[a.device_uuid].device_name=a.device_name
 }

 registro_alarmas.registrar(a)

}

node.on("input",function(msg){

 // Spec 008: el evento de alarma (salida 2 de modbus-variable o module-production,
 // o la de alarm-generator) trae el device_uuid dentro del payload, no en la raíz
 // del mensaje. Spec 010: se reconoce por alarm_uuid.
 if(msg.payload && typeof msg.payload==="object" && msg.payload.alarm_uuid!==undefined){
  registrarAlarma(msg.payload)
  return
 }

 if(!msg.device_uuid || msg.payload===undefined) return

 // CA8: sin los dos identificadores válidos, el mensaje se descarta. Antes de
 // esta spec la clave era el nombre (msg.variable_name||msg.topic); ahora es
 // el uuid, que es obligatorio en todos los entornos (RN2).
 if(!naturaleza.esUuidV4(msg.device_uuid) || !naturaleza.esUuidV4(msg.variable_uuid)){

  let claveDescarte=(msg.device_uuid||"?")+"|"+(msg.variable_uuid||msg.variable_name||msg.topic||"?")

  if(!node.avisosDescartados[claveDescarte]){
   node.avisosDescartados[claveDescarte]=true
   node.error(`mensaje descartado: device_uuid ("${msg.device_uuid}") o variable_uuid ("${msg.variable_uuid}") no es un uuid v4 válido`)
  }

  return
 }

 // Spec 009: nature es obligatoria en el paquete. Una variable que llega sin una
 // nature válida (no salió de un uso declarado) no se resume ni se publica.
 if(!naturaleza.NATURALEZAS.includes(msg.nature)){

  let claveNature=msg.device_uuid+"|"+msg.variable_uuid+"|nature"

  if(!node.avisosDescartados[claveNature]){
   node.avisosDescartados[claveNature]=true
   node.error(`mensaje descartado: la variable "${msg.variable_name||msg.variable_uuid}" no trae una nature válida (${naturaleza.NATURALEZAS.join(", ")}); declara su uso en el nodo que la genera`)
  }

  return

 }

 let device_id=msg.device_uuid
 let variable=msg.variable_uuid
 let nombreVariable=msg.variable_name||variable
 let value=Number(msg.payload)
 let timestamp=Math.floor((msg.timestamp||Date.now())/1000)


if(!devices[device_id]){
  devices[device_id]={
    device_uuid: device_id,
    device_name: msg.device_name || "",
    variables: {}
  }
}
 let device=devices[device_id]

 // RN5/CA10: el mismo variable_uuid con otro nombre EN LA MISMA VENTANA es un
 // duplicado — se publica solo la primera. `count>0` es "ya hubo una muestra
 // de esta variable en la ventana en curso"; en la primera muestra de cada
 // ventana (recién creada o recién reiniciada por generateReport) el nombre
 // se acepta tal cual, para que un cambio de nombre entre ventanas (E1, CA11)
 // sí se refleje.
 if(device.variables[variable] && device.variables[variable].count>0
   && device.variables[variable].name!==nombreVariable){

  let claveDuplicado=device_id+"|"+variable

  if(!node.avisosDuplicado[claveDuplicado]){
   node.avisosDuplicado[claveDuplicado]=true
   node.error(`variable_uuid "${variable}" repetido en "${device_id}" con nombres distintos ("${device.variables[variable].name}" y "${nombreVariable}"); se publica solo la primera`)
  }

  return
 }

 if(device.variables[variable]){
  // Primera muestra de la ventana (o mismo nombre que ya tenía): al nombre se
  // le permite cambiar de una ventana a otra sin que cambie la identidad.
  device.variables[variable].name=nombreVariable
 }

 if(!device.variables[variable]){

  let thrState=(msg.thresholds||[]).map(t=>({

   config:t,
   active:false,
   start:null,

   sum:0,
   count:0,
   min:null,
   max:null,
   sum_sq:0,

   ranges:[]

  }))

  device.variables[variable]={

   name:nombreVariable,
   unit:msg.unit||"",

   // Cómo se agrega la ventana de esta variable. Obligatoria: modbus-variable no
   // emite una variable sin uso válido.
   nature:msg.nature,

   // En qué cálculo de negocio entra. Opcional.
   role:msg.role,

   sum:0,
   count:0,
   min:null,
   max:null,
   sum_sq:0,

   // Última muestra del intervalo: es el valor de la ventana de un estado.
   last:null,

   thresholds:thrState

  }

 }

 let v=device.variables[variable]

 v.sum+=value
 v.count++
 v.sum_sq+=(value*value)
 v.last=value

 if(v.min===null||value<v.min) v.min=value
 if(v.max===null||value>v.max) v.max=value

 for(let thr of v.thresholds){

  let conditionMet=checkCondition(value,thr.config)

  if(conditionMet){

   if(!thr.active){

    thr.active=true
    thr.start=timestamp

    thr.sum=0
    thr.count=0
    thr.min=null
    thr.max=null
    thr.sum_sq=0

   }

   thr.sum+=value
   thr.count++
   thr.sum_sq+=(value*value)

   if(thr.min===null||value<thr.min) thr.min=value
   if(thr.max===null||value>thr.max) thr.max=value

  }

  else{

   if(thr.active){
      if(thr.count > 0){
        let avg=thr.count?thr.sum/thr.count:0
        let std=getStdDev(thr.sum,thr.sum_sq,thr.count)

        thr.ranges.push({

           start_threshold_range:thr.start,
           end_threshold_range:timestamp,

           sum:round2(thr.sum),
           samples_count:thr.count,
           average:round2(avg),
           max:round2(thr.max),
           min:round2(thr.min),
           standard_deviation:round2(std),
           sum_squares:round2(thr.sum_sq)

        })
      }
      // Cerrar definitivamente el umbral
      thr.active = false
      thr.start = null

      // Limpiar acumuladores
      thr.sum = 0
      thr.count = 0
      thr.min = null
      thr.max = null
      thr.sum_sq = 0

   }

}

 }

})

function generateReport(){

 let end_range=Math.floor(Date.now()/1000)

 for(let device_id in devices){

  let device=devices[device_id]

  let data=[]

  for(let key in device.variables){

   let v=device.variables[key]

   let avg=v.count?v.sum/v.count:0
   let std=getStdDev(v.sum,v.sum_sq,v.count)

   let thresholds=[]

   for(let thr of v.thresholds){

    if(thr.active){
       if(thr.count > 0){
         let avgR=thr.count?thr.sum/thr.count:0
         let stdR=getStdDev(thr.sum,thr.sum_sq,thr.count)


         thr.ranges.push({

          start_threshold_range:thr.start,
          end_threshold_range:end_range,

          sum:round2(thr.sum),
          samples_count:thr.count,
          average:round2(avgR),
          max:round2(thr.max),
          min:round2(thr.min),
          standard_deviation:round2(stdR),
          sum_squares:round2(thr.sum_sq)

         })
       }
     // Preparar el siguiente intervalo
      thr.start = end_range

      thr.sum = 0
      thr.count = 0
      thr.min = null
      thr.max = null
      thr.sum_sq = 0

    // NO cambiar thr.active

    }

    thresholds.push({

     threshold_id:thr.config.name,
     // El código de la condición (gt, gte, eq, lte, lt, between), no un símbolo.
     validation: naturaleza.normalizarCondicion(thr.config.condition),
     value:thr.config.value,
     value2:thr.config.value2||null,

     ranges:thr.ranges

    })

   }

   data.push({

    variable_uuid:key,
    name:v.name,
    unit:v.unit,
    ...(v.nature?{nature:v.nature}:{}),
    ...(v.role?{role:v.role}:{}),

    summary:{

     sum:round2(v.sum),
     samples_count:v.count,
     average:round2(avg),
     max:round2(v.max),
     min:round2(v.min),
     standard_deviation:round2(std),
     sum_squares:round2(v.sum_sq),
     last:v.count?round2(v.last):null

    },

    thresholds:thresholds

   })

  }
  let report={

    record_uuid:RED.util.generateId(),

    device_uuid: device.device_uuid,
    device_name: device.device_name,

    start_range:start_range,
    end_range:end_range,

    data:data,

    alarms:registro_alarmas.deVentana(device.device_uuid,start_range,end_range)

  }

  node.send({ payload: report })

 }

 for(let device_id in devices){

    let device = devices[device_id]

    for(let key in device.variables){

        let v = device.variables[key]

        // Reiniciar estadísticas de la variable
        v.sum = 0
        v.count = 0
        v.min = null
        v.max = null
        v.sum_sq = 0
        v.last = null

        // Limpiar los rangos ya reportados
        for(let thr of v.thresholds){
            thr.ranges = []
        }

    }

}

registro_alarmas.limpiar(end_range)

start_range = end_range

}

let timer=setInterval(generateReport,interval_ms)

node.on("close",function(){

 clearInterval(timer)

})

}

RED.nodes.registerType("device-reporter",DeviceReporter)

}
