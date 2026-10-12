module.exports = function(RED){

const naturaleza=require("../../resources/naturaleza-variable")
const alarmas=require("../../resources/alarmas")

function ProductionReporter(config){

RED.nodes.createNode(this,config)

let node=this

// CA9 (spec 007): descarta con un aviso, una vez por clave, una variable sin
// variable_uuid válido. Igual que device-reporter (CA8), pero por dispositivo.
node.avisosDescartados={}

let interval=Number(config.interval)||60
let unit=config.unit||"seconds"

let multiplier={
 seconds:1000,
 minutes:60000,
 hours:3600000
}

let interval_ms=interval*(multiplier[unit]||1000)

// =========================
// 🔹 ESTADO
// =========================
let devices={}
// Spec 010: las alarmas se separan por dispositivo y su clave es
// (device_uuid, catalog, alarm_uuid), igual que en device-reporter.
let registro_alarmas=alarmas.crearRegistroDeAlarmas()
node.avisosAlarma={}

// 🔹 THRESHOLDS
let thresholds_active={}
let thresholds_history=[]

let start_range=Math.floor(Date.now()/1000)

// =========================
// 🔹 FUNCIONES
// =========================
function getStdDev(sum,sum_sq,count){
 if(count<=1) return 0
 let mean=sum/count
 let variance=(sum_sq/count)-(mean*mean)
 if(variance<0) variance=0
 return Math.sqrt(variance)
}

function round2(n){
 if(n===null||n===undefined||isNaN(n)) return n
 return Math.round((n+Number.EPSILON)*100)/100
}

// =========================
// 🔹 INPUT
// =========================
node.on("input",function(msg){

 // =========================
 // 🔹 VARIABLES
 // =========================
 if(msg.variables){

  let device_id=msg.device_uuid

  if(!devices[device_id]){
   devices[device_id]={
    device_name:msg.device_name,
    variables:{}
   }
  }

  let device=devices[device_id]

  msg.variables.forEach(v=>{

   if(!naturaleza.esUuidV4(v.variable_uuid)){

    let clave=device_id+"|"+(v.variable_name||"?")

    if(!node.avisosDescartados[clave]){
     node.avisosDescartados[clave]=true
     node.error(`${v.variable_name||"(sin nombre)"}: variable_uuid ausente o inválido; se descarta`)
    }

    return
   }

   // Spec 009: nature es obligatoria en el paquete. Una variable sin nature
   // válida (no salió de un uso declarado) no se resume ni se publica.
   if(!naturaleza.NATURALEZAS.includes(v.nature)){

    let claveNature=device_id+"|"+v.variable_uuid+"|nature"

    if(!node.avisosDescartados[claveNature]){
     node.avisosDescartados[claveNature]=true
     node.error(`${v.variable_name||"(sin nombre)"}: nature ausente o inválida; se descarta`)
    }

    return
   }

   if(!device.variables[v.variable_uuid]){
    device.variables[v.variable_uuid]={

     variable_uuid:v.variable_uuid,
     name:v.variable_name||v.variable_uuid,
     unit:v.unit||"",

     // La naturaleza la declara quien conoce el sensor (module-production): la
     // presencia es un estado, no un contador.
     nature:v.nature,
     role:v.role,

     sum:0,
     count:0,
     min:null,
     max:null,
     sum_sq:0,
     last:null

    }
   }

   // Un estado (la presencia) resume su nivel en la muestra; un contador, las
   // botellas contadas en ella.
   let val=(v.nature==="state" ? Number(v.state) : Number(v.count))||0
   let variable=device.variables[v.variable_uuid]

   // Spec 010 (D13): la muestra cubre [start_range, end_range], que con
   // sample_interval puede ser de más de un segundo. Un estado pesa lo que dura la
   // muestra, de modo que su suma son los segundos en alto; min, max y last siguen
   // siendo el nivel (0 o 1). Con un segundo por muestra el peso es 1.
   let peso=1

   if(v.nature==="state"){
    peso=Math.max(1,(Number(msg.end_range)-Number(msg.start_range))||1)
   }

   variable.sum+=val*peso
   variable.count++
   variable.sum_sq+=(val*peso)*(val*peso)
   variable.last=val

   if(variable.min===null||val<variable.min){
    variable.min=val
   }

   if(variable.max===null||val>variable.max){
    variable.max=val
   }

   // =========================
   // 🔹 THRESHOLDS
   // =========================
   if(Array.isArray(v.thresholds)){

    v.thresholds.forEach(t=>{

     let key=
      device_id+"|"+
      v.variable_uuid+"|"+
      t.name

     let ts=Number(t.timestamp)||Date.now()

     // convertir ms -> seg
     if(ts>9999999999){
      ts=Math.floor(ts/1000)
     }

     // Inicio de la muestra: module-production evalúa cada segundo, así que una
     // muestra cubre [start_timestamp, timestamp] y un tramo de k segundos seguidos
     // dura exactamente k. Sin start_timestamp (un emisor anterior) la muestra
     // se toma puntual, como antes.
     let ts_inicio=Number(t.start_timestamp)||ts

     if(ts_inicio>9999999999){
      ts_inicio=Math.floor(ts_inicio/1000)
     }

     // =========================
     // 🔹 CONDITION TRUE
     // =========================
     if(t.condition_met){

      if(!thresholds_active[key]){

       thresholds_active[key]={

        device_uuid:device_id,
        variable_uuid:v.variable_uuid,

        threshold_id:t.name,
        validation:naturaleza.normalizarCondicion(t.condition),
        value:t.value,
        value2:t.value2===undefined||t.value2===""?null:t.value2,

        start:ts_inicio,
        end:ts,

        sum:0,
        count:0,
        min:null,
        max:null,
        sum_sq:0

       }

      }

      let active=thresholds_active[key]

      active.end=ts

      active.sum+=val
      active.count++
      active.sum_sq+=(val*val)

      if(active.min===null||val<active.min){
       active.min=val
      }

      if(active.max===null||val>active.max){
       active.max=val
      }

     }

     // =========================
     // 🔹 CONDITION FALSE
     // =========================
     else{

      if(thresholds_active[key]){

       thresholds_history.push(
        thresholds_active[key]
       )

       delete thresholds_active[key]

      }

     }

    })

   }

  })

 }

 // =========================
 // 🔹 ALARMAS
 // =========================
 // Un mensaje de alarma (salida 2 de module-production o modbus-variable, o
 // alarm-generator) se reconoce por payload.alarm_uuid (spec 010).
 if(msg.payload && typeof msg.payload==="object" && msg.payload.alarm_uuid!==undefined){

  let p=msg.payload
  let errores=alarmas.validarAlarma(p)

  if(errores.length){

   let claveAviso=p.device_uuid+"|"+p.catalog+"|"+p.alarm_uuid

   if(!node.avisosAlarma[claveAviso]){
    node.avisosAlarma[claveAviso]=true
    node.error(`alarma descartada: ${errores.join("; ")}`)
   }

   return

  }

  let a=alarmas.normalizarAlarma(p)

  // Como en device-reporter: el dispositivo entra en el informe aunque aún no
  // tenga muestras en la ventana.
  if(!devices[a.device_uuid]){
   devices[a.device_uuid]={
    device_name:a.device_name,
    variables:{}
   }
  }

  registro_alarmas.registrar(a)

 }

})

// =========================
// 🔹 GENERAR REPORTE
// =========================
function generateReport(){

 let end_range=Math.floor(Date.now()/1000)

 for(let device_id in devices){

  let device=devices[device_id]

  // =========================
  // 🔹 VARIABLES
  // =========================
  let variables=Object.values(device.variables).map(v=>{

   let avg=v.count?v.sum/v.count:0
   let std=getStdDev(v.sum,v.sum_sq,v.count)

   // =========================
   // 🔹 THRESHOLDS REPORT
   // =========================
   let grouped_thresholds={}

   // 🔹 HISTORICOS
   thresholds_history.forEach(t=>{

    if(
     t.device_uuid===device_id &&
     t.variable_uuid===v.variable_uuid
    ){

     if(!grouped_thresholds[t.threshold_id]){

      grouped_thresholds[t.threshold_id]={

       threshold_id:t.threshold_id,
       validation:t.validation,
       value:t.value,
       value2:t.value2,

       ranges:[]

      }

     }

     let t_avg=t.count?t.sum/t.count:0

     let t_std=getStdDev(
      t.sum,
      t.sum_sq,
      t.count
     )

     grouped_thresholds[t.threshold_id]
     .ranges.push({

      start_threshold_range:
       Math.max(t.start,start_range),

      end_threshold_range:
       Math.min(t.end,end_range),

      sum:round2(t.sum),
      samples_count:t.count,
      average:round2(t_avg),
      max:round2(t.max),
      min:round2(t.min),
      standard_deviation:round2(t_std),
      sum_squares:round2(t.sum_sq)

     })

    }

   })

   // 🔹 ACTIVOS
   Object.values(thresholds_active).forEach(t=>{

    if(
     t.device_uuid===device_id &&
     t.variable_uuid===v.variable_uuid
    ){

     if(!grouped_thresholds[t.threshold_id]){

      grouped_thresholds[t.threshold_id]={

       threshold_id:t.threshold_id,
       validation:t.validation,
       value:t.value,
       value2:t.value2,

       ranges:[]

      }

     }

     let t_avg=t.count?t.sum/t.count:0

     let t_std=getStdDev(
      t.sum,
      t.sum_sq,
      t.count
     )

     grouped_thresholds[t.threshold_id]
     .ranges.push({

      start_threshold_range:
       Math.max(t.start,start_range),

      end_threshold_range:end_range,

      sum:round2(t.sum),
      samples_count:t.count,
      average:round2(t_avg),
      max:round2(t.max),
      min:round2(t.min),
      standard_deviation:round2(t_std),
      sum_squares:round2(t.sum_sq)

     })

    }

   })

   let thresholds=
    Object.values(grouped_thresholds)

   return{

    variable_uuid:v.variable_uuid,
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

   }

  })

  // =========================
  // 🔹 ALARMAS
  // =========================
  let report_alarms=registro_alarmas.deVentana(device_id,start_range,end_range)

  // =========================
  // 🔹 REPORTE FINAL
  // =========================
  let report={

   record_uuid:RED.util.generateId(),

   device_uuid:device_id,
   device_name:device.device_name,

   start_range:start_range,
   end_range:end_range,

   data:variables,
   alarms:report_alarms

  }

  node.send({ payload: report })

 }

 // =========================
 // 🔹 LIMPIEZA
 // =========================
 registro_alarmas.limpiar(end_range)

 thresholds_history=
  thresholds_history.filter(
   t=>t.end>end_range
  )

 devices={}
 start_range=end_range
 // =========================
 // 🔹 REINICIAR SEGMENTOS
 // 🔹 THRESHOLDS ACTIVOS
 // =========================
 Object.values(thresholds_active).forEach(t=>{

  t.start=end_range

  t.sum=0
  t.count=0
  t.sum_sq=0

  t.min=null
  t.max=null

})

}

// =========================
// 🔹 TIMER
// =========================
let timer=setInterval(
 generateReport,
 interval_ms
)

node.on("close",function(){
 clearInterval(timer)
})

}

RED.nodes.registerType(
 "production-reporter",
 ProductionReporter
)

}