module.exports = function(RED){

function DeviceReporter(config){

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

let devices={}

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

function checkCondition(value,thr){

 let v1=Number(thr.value)
 let v2=Number(thr.value2)

 switch(thr.condition){

  case "gt": return value>v1
  case "gte": return value>=v1
  case "lt": return value<v1
  case "lte": return value<=v1
  case "eq": return value===v1
  case "between": return value>=v1 && value<=v2
  default: return false

 }

}

node.on("input",function(msg){

 if(!msg.device_uuid || msg.payload===undefined) return

 let device_id=msg.device_uuid
 let variable=msg.variable_name||msg.topic
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

   name:variable,
   unit:msg.unit||"",
   type:msg.type||"instantaneous",

   sum:0,
   count:0,
   min:null,
   max:null,
   sum_sq:0,

   thresholds:thrState

  }

 }

 let v=device.variables[variable]

 v.sum+=value
 v.count++
 v.sum_sq+=(value*value)

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

const conditionText = {
    gt: ">",
    gte: ">=",
    eq: "==",
    lte: "<=",
    lt: "<",
    between: "><"
};

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
     validation: conditionText[thr.config.condition] || thr.config.condition,
     value:thr.config.value,
     value2:thr.config.value2||null,

     ranges:thr.ranges

    })

   }

   data.push({

    variable_uuid:key,
    name:v.name,
    unit:v.unit,
    type:v.type,

    summary:{

     sum:round2(v.sum),
     samples_count:v.count,
     average:round2(avg),
     max:round2(v.max),
     min:round2(v.min),
     standard_deviation:round2(std),
     sum_squares:round2(v.sum_sq)

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

    data:data

  }

  node.send(report)

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

        // Limpiar los rangos ya reportados
        for(let thr of v.thresholds){
            thr.ranges = []
        }

    }

}

start_range = end_range

}

let timer=setInterval(generateReport,interval_ms)

node.on("close",function(){

 clearInterval(timer)

})

}

RED.nodes.registerType("device-reporter",DeviceReporter)

}
