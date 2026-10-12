/*=========================================================
=            ALARMAS (spec 010, contratos C-01 v3 y C-32)
=========================================================*/

// Lo que comparten las tres fuentes de alarma (module-production,
// modbus-variable y alarm-generator), los dos reporters y alarm-publisher:
//
//   - el formato único del mensaje de alarma (payload de la salida de alarmas);
//   - su validación;
//   - el registro de tramos que los reporters declaran en alarms[];
//   - el evento alarm-event/v1 que publica alarm-publisher.
//
// Solo corre en Node (runtime); el editor no lo carga.

"use strict"

const naturaleza=require("./naturaleza-variable")

const ESQUEMA_EVENTO="alarm-event/v1"
const PREFIJO_TOPIC="mentor_alarms/"

function vacio(valor){
 return valor===undefined || valor===null || valor===""
}

/*---------------- validación del mensaje de alarma ----------------*/

// Motivos por los que un payload no es una alarma válida. Lista vacía = válida.
//
//   {device_uuid, device_name, catalog, alarm_uuid, alarm_name, state, value, unit,
//    timestamp (ms, instante real del cambio),
//    severity, variable_uuid, threshold  (solo alarm-generator)}
function validarAlarma(p){

 let errores=[]

 if(!p || typeof p!=="object"){
  return ["el mensaje de alarma no es un objeto"]
 }

 if(!naturaleza.esUuidV4(p.device_uuid)){
  errores.push('device_uuid ("'+p.device_uuid+'") no es un uuid v4 válido')
 }

 if(!naturaleza.CATALOGOS_DE_ALARMA.includes(p.catalog)){
  errores.push('catalog ("'+p.catalog+'") no existe; admitidos: '+naturaleza.CATALOGOS_DE_ALARMA.join(", "))
 }else if(!naturaleza.esUuidDeAlarma(p.alarm_uuid,p.catalog)){
  errores.push('alarm_uuid ("'+p.alarm_uuid+'") no es válido en el catálogo '+p.catalog
   +(p.catalog==="alarm-generator" ? " (uuid v4)" : " (uno de los reservados)"))
 }

 if(typeof p.alarm_name!=="string" || p.alarm_name.trim()===""){
  errores.push("alarm_name falta")
 }

 if(p.state!==0 && p.state!==1){
  errores.push("state tiene que ser 0 o 1")
 }

 if(p.catalog==="alarm-generator"){

  if(!naturaleza.SEVERIDADES.includes(p.severity)){
   errores.push('severity ("'+p.severity+'") no existe; admitidas: '+naturaleza.SEVERIDADES.join(", "))
  }

  if(!naturaleza.esUuidV4(p.variable_uuid)){
   errores.push("variable_uuid falta o no es un uuid v4 válido")
  }

  if(!p.threshold || typeof p.threshold!=="object" || vacio(p.threshold.name)){
   errores.push("threshold falta o no tiene nombre")
  }

 }

 return errores

}

/*---------------- forma canónica ----------------*/

// El mensaje con solo lo que se conserva, y el instante del cambio en ms (el
// momento actual si el mensaje no lo trae). severity, variable_uuid y threshold
// solo existen en alarm-generator.
function normalizarAlarma(p,ahora){

 let t=Number(p.timestamp)

 let a={
  device_uuid:p.device_uuid,
  device_name:vacio(p.device_name) ? "" : p.device_name,
  catalog:p.catalog,
  alarm_uuid:p.alarm_uuid,
  alarm_name:p.alarm_name,
  state:p.state,
  value:p.value===undefined ? "" : p.value,
  unit:vacio(p.unit) ? "" : p.unit,
  timestamp:(Number.isFinite(t) && t>0) ? t : (ahora===undefined ? Date.now() : ahora)
 }

 if(p.catalog==="alarm-generator"){
  a.severity=p.severity
  a.variable_uuid=p.variable_uuid
  a.threshold=p.threshold
 }

 return a

}

/*---------------- registro de tramos (reporters) ----------------*/

// La clave de una alarma es (device_uuid, catalog, alarm_uuid): sin el catálogo,
// el alarm_uuid de un alarm-generator podría chocar con otra alarma, y sin el
// equipo, la alarma de un dispositivo saldría en el paquete de otro.
function claveDeAlarma(a){
 return a.device_uuid+"|"+a.catalog+"|"+a.alarm_uuid
}

function crearRegistroDeAlarmas(){

 let activas={}
 let historial=[]

 // state 1 abre el tramo (si ya estaba abierto no se mueve su inicio) y state 0
 // lo cierra. Los instantes son segundos, a partir del timestamp del mensaje.
 function registrar(a){

  let ts=Math.floor(a.timestamp/1000)
  let clave=claveDeAlarma(a)

  if(a.state===1){

   if(!activas[clave]){
    activas[clave]=Object.assign({},a,{start:ts})
   }

  }else if(a.state===0 && activas[clave]){

   let activa=activas[clave]

   historial.push(Object.assign({},activa,{end:Math.max(ts,activa.start)}))
   delete activas[clave]

  }

 }

 // Las alarmas del dispositivo con algún tramo dentro de [inicio, fin], agrupadas
 // por (catalog, alarm_uuid) con sus tramos recortados a la ventana. Un tramo
 // abierto sale con fin = fin de la ventana y el siguiente paquete sigue desde ahí.
 function deVentana(device_uuid,inicio,fin){

  let agrupadas={}

  function grupo(a){

   let clave=a.catalog+"|"+a.alarm_uuid

   if(!agrupadas[clave]){

    let entrada={
     catalog:a.catalog,
     alarm_uuid:a.alarm_uuid
    }

    if(a.catalog==="alarm-generator") entrada.severity=a.severity

    agrupadas[clave]=Object.assign(entrada,{
     alarm_name:a.alarm_name,
     state:1,
     value:a.value,
     unit:a.unit,
     ranges:[]
    })

   }

   return agrupadas[clave]

  }

  historial.forEach(function(a){

   if(a.device_uuid===device_uuid && a.start<fin && a.end>inicio){
    grupo(a).ranges.push({
     start_alarm_range:Math.max(a.start,inicio),
     end_alarm_range:Math.min(a.end,fin)
    })
   }

  })

  Object.keys(activas).forEach(function(clave){

   let a=activas[clave]

   if(a.device_uuid===device_uuid && a.start<fin){
    grupo(a).ranges.push({
     start_alarm_range:Math.max(a.start,inicio),
     end_alarm_range:fin
    })
   }

  })

  return Object.keys(agrupadas).map(function(k){ return agrupadas[k] })

 }

 // Tras cerrar una ventana: los tramos que terminaron antes de su fin ya se
 // declararon y se olvidan.
 function limpiar(fin){
  historial=historial.filter(function(a){ return a.end>fin })
 }

 return {registrar:registrar,deVentana:deVentana,limpiar:limpiar}

}

/*---------------- evento inmediato (C-32) ----------------*/

function numeroONulo(valor){
 if(vacio(valor)) return null
 let n=Number(valor)
 return Number.isFinite(n) ? n : null
}

// alarm-event/v1. changed_at es el instante real del cambio (inicio o fin de la
// condición, no del fin del retardo) y emitted_at, cuándo se emite; el
// consumidor usa emitted_at para no confundir el evento con un resumen del minuto
// que se cerró antes de conocerlo. value es un número o null (las alarmas de
// comunicación no tienen lectura).
function construirEvento(a,ahora,idEvento){

 let e={
  schema:ESQUEMA_EVENTO,
  event_uuid:idEvento,
  device_uuid:a.device_uuid,
  device_name:a.device_name,
  catalog:a.catalog,
  alarm_uuid:a.alarm_uuid,
  alarm_name:a.alarm_name
 }

 if(a.catalog==="alarm-generator") e.severity=a.severity

 e.state=a.state
 e.value=numeroONulo(a.value)
 e.unit=a.unit

 if(a.catalog==="alarm-generator"){

  e.variable_uuid=a.variable_uuid

  e.threshold={
   name:a.threshold.name,
   condition:naturaleza.normalizarCondicion(a.threshold.condition)||null,
   value1:numeroONulo(a.threshold.value1),
   value2:numeroONulo(a.threshold.value2)
  }

 }

 e.changed_at=Math.round(a.timestamp)
 e.emitted_at=ahora

 return e

}

module.exports={
 ESQUEMA_EVENTO:ESQUEMA_EVENTO,
 PREFIJO_TOPIC:PREFIJO_TOPIC,
 validarAlarma:validarAlarma,
 normalizarAlarma:normalizarAlarma,
 claveDeAlarma:claveDeAlarma,
 crearRegistroDeAlarmas:crearRegistroDeAlarmas,
 construirEvento:construirEvento
}
