module.exports = function(RED){

function RandomGenerator(config){

RED.nodes.createNode(this,config)

let node=this

// ===== CONFIG =====
let min=Number(config.min)||0
let max=Number(config.max)||100
let interval=Number(config.interval)||1
let unit=config.unit||"seconds"
let mode=config.mode||"random"

let numberType=config.numberType||"decimal"
let decimals=Number(config.decimals)||2

let steps=Number(config.steps)||5
let stepMode=config.stepMode||"random"

let speed=Number(config.speed)||0.2
let outputType=config.outputType||"number"

// ===== VALIDACIONES =====
if(min > max){
 let tmp=min
 min=max
 max=tmp
}

if(interval <= 0) interval=1
if(steps < 2) steps=2

// ===== TIEMPO =====
let multiplier={
 seconds:1000,
 minutes:60000
}

let interval_ms=interval*(multiplier[unit]||1000)

// ===== ESTADOS =====
let current=(min+max)/2
let angle=0
let stepIndex=0

// ===== GENERAR STEPS =====
let stepValues=[]
let stepSize=(max-min)/(steps-1)

for(let i=0;i<steps;i++){
 let v=min + i*stepSize
 stepValues.push(Number(v.toFixed(2)))
}

// ===== FORMAT =====
function format(value){

 if(numberType==="integer"){
  value = Math.round(value)
 }else{
  value = Number(value.toFixed(decimals))
 }

 if(outputType==="string"){
  return String(value)
 }

 return value

}

// ===== CLAMP =====
function clamp(value){
 return Math.max(min,Math.min(max,value))
}

// ===== GENERADOR =====
function generate(){

 let value

 switch(mode){

  case "smooth":
   let target=Math.random()*(max-min)+min
   current += (target-current)*0.2
   value=current
   break

  case "walk":
   let step=(max-min)*0.05
   current += (Math.random()*2-1)*step
   value=current
   break

  case "sine":
   angle += speed
   value = min + (Math.sin(angle)+1)/2*(max-min)
   break

  case "step":

   if(stepMode==="sequential"){

    value=stepValues[stepIndex]
    stepIndex=(stepIndex+1)%stepValues.length

   }else{

    let idx=Math.floor(Math.random()*stepValues.length)
    value=stepValues[idx]

   }

   break

  default:
   value=Math.random()*(max-min)+min

 }

 value = clamp(value)
 value = format(value)

 node.status({text:String(value)})

 node.send({
  payload:value
 })

}

// ===== INICIO INMEDIATO =====
generate()

let timer=setInterval(generate,interval_ms)

node.on("close",function(){
 clearInterval(timer)
})

}

RED.nodes.registerType("random-generator",RandomGenerator)

}