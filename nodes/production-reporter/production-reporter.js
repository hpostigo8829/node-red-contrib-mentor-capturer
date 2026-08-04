module.exports = function(RED){

function ProductionReporter(config){

RED.nodes.createNode(this,config)

let node=this

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
let alarms_active={}
let alarms_history=[]

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
 return Math.sqrt((sum_sq/count)-(mean*mean))
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

   if(!device.variables[v.variable_name]){
    device.variables[v.variable_name]={

     variable_uuid:v.variable_name,
     name:v.variable_name,
     unit:v.unit||"",
     type:"counter",

     sum:0,
     count:0,
     min:null,
     max:null,
     sum_sq:0

    }
   }

   let val=Number(v.count)||0
   let variable=device.variables[v.variable_name]

   variable.sum+=val
   variable.count++
   variable.sum_sq+=(val*val)

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
      v.variable_name+"|"+
      t.name

     let ts=Number(t.timestamp)||Date.now()

     // convertir ms -> seg
     if(ts>9999999999){
      ts=Math.floor(ts/1000)
     }

     // =========================
     // 🔹 CONDITION TRUE
     // =========================
     if(t.condition_met){

      if(!thresholds_active[key]){

       thresholds_active[key]={

        device_uuid:device_id,
        variable_name:v.variable_name,

        threshold_id:t.name,
        validation:t.condition,
        value:t.value,

        start:ts,
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
 if(msg.payload && msg.payload.alarm_id!==undefined){

  let a=msg.payload
  let id=a.alarm_id
  let ts=Math.floor((a.timestamp||Date.now())/1000)

  if(a.state===1){

   alarms_active[id]={

    alarm_id:a.alarm_id,
    alarm_name:a.alarm_name,
    value:a.value,
    unit:a.unit,
    start:ts

   }

  }

  else if(a.state===0){

   if(alarms_active[id]){

    let active=alarms_active[id]

    alarms_history.push({

     alarm_id:active.alarm_id,
     alarm_name:active.alarm_name,
     value:active.value,
     unit:active.unit,
     start:active.start,
     end:ts

    })

    delete alarms_active[id]

   }

  }

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
     t.variable_name===v.variable_uuid
    ){

     if(!grouped_thresholds[t.threshold_id]){

      grouped_thresholds[t.threshold_id]={

       threshold_id:t.threshold_id,
       validation:t.validation,
       value:t.value,

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

      sum:t.sum,
      samples_count:t.count,
      average:t_avg,
      max:t.max,
      min:t.min,
      standard_deviation:t_std

     })

    }

   })

   // 🔹 ACTIVOS
   Object.values(thresholds_active).forEach(t=>{

    if(
     t.device_uuid===device_id &&
     t.variable_name===v.variable_uuid
    ){

     if(!grouped_thresholds[t.threshold_id]){

      grouped_thresholds[t.threshold_id]={

       threshold_id:t.threshold_id,
       validation:t.validation,
       value:t.value,

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

      sum:t.sum,
      samples_count:t.count,
      average:t_avg,
      max:t.max,
      min:t.min,
      standard_deviation:t_std

     })

    }

   })

   let thresholds=
    Object.values(grouped_thresholds)

   return{

    variable_uuid:v.variable_uuid,
    name:v.name,
    unit:v.unit,
    type:v.type,

    summary:{
     sum:v.sum,
     samples_count:v.count,
     average:avg,
     max:v.max,
     min:v.min,
     standard_deviation:std
    },

    thresholds:thresholds

   }

  })

  // =========================
  // 🔹 ALARMAS
  // =========================
  let grouped={}

  // 🔹 CERRADAS
  for(let a of alarms_history){

   if(a.start < end_range && a.end > start_range){

    if(!grouped[a.alarm_id]){

     grouped[a.alarm_id]={

      alarm_id:a.alarm_id,
      alarm_name:a.alarm_name,
      state:1,
      value:a.value,
      unit:a.unit,

      ranges:[]

     }

    }

    grouped[a.alarm_id].ranges.push({

     start_alarm_range:
      Math.max(a.start,start_range),

     end_alarm_range:
      Math.min(a.end,end_range)

    })

   }

  }

  // 🔹 ACTIVAS
  for(let id in alarms_active){

   let a=alarms_active[id]

   if(a.start < end_range){

    if(!grouped[a.alarm_id]){

     grouped[a.alarm_id]={

      alarm_id:a.alarm_id,
      alarm_name:a.alarm_name,
      state:1,
      value:a.value,
      unit:a.unit,

      ranges:[]

     }

    }

    grouped[a.alarm_id].ranges.push({

     start_alarm_range:
      Math.max(a.start,start_range),

     end_alarm_range:end_range

    })

   }

  }

  let report_alarms=Object.values(grouped)

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

  node.send(report)

 }

 // =========================
 // 🔹 LIMPIEZA
 // =========================
 alarms_history=
  alarms_history.filter(
   a=>a.end>end_range
  )

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