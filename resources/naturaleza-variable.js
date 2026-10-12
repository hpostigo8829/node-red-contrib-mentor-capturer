/*=========================================================
=            USO DE UNA VARIABLE
=========================================================*/

// Reglas compartidas por el editor y el runtime. Node-RED sirve la carpeta
// resources/ del paquete en resources/node-red-contrib-mentor-capturer/, así que
// el mismo archivo lo cargan los editores con <script> y lo requieren
// modbus-variable.js, module-production.js y los dos reporters.
//
// El técnico declara UN solo dato por variable, su uso (usage), y el catálogo
// resources/usos.json lo traduce a los dos campos que viajan en el paquete:
//
//   nature  cómo se agrega la ventana
//     increment      lo ocurrido dentro de la ventana (pulsos, conteo)  -> sum
//     cumulative     registro que crece y solo baja al reiniciarse (kWh) -> una lectura
//     instantaneous  nivel medido en un instante (tensión, potencia)
//     state          código discreto (presencia)                        -> last
//   role    en qué cálculo de negocio entra (opcional)
//
// usage NO viaja: solo vive en la configuración del capturador. Una variable sin
// un uso válido no se emite.

(function(raiz,fabrica){

 var esNode=typeof module==="object" && module.exports

 if(esNode){
  module.exports=fabrica(esNode)
 }else{
  raiz.MentorNaturalezaVariable=fabrica(esNode)
 }

})(typeof self!=="undefined" ? self : this,function(esNode){

"use strict"

// El catálogo es un solo archivo JSON. En Node se requiere; en el editor se lee
// con una petición síncrona (una sola vez, al cargar este script), porque los
// nodos necesitan el catálogo ya en memoria cuando registran su formulario.
function cargarCatalogo(){

 if(esNode) return require("./usos.json")

 try{

  let xhr=new XMLHttpRequest()
  xhr.open("GET","resources/node-red-contrib-mentor-capturer/usos.json",false)
  xhr.send(null)

  if(xhr.status>=200 && xhr.status<300) return JSON.parse(xhr.responseText)

 }catch(e){}

 return {version:0,unidades_sugeridas:[],usos:[]}

}

const CATALOGO=cargarCatalogo()

const USOS=CATALOGO.usos
const UNIDADES_SUGERIDAS=CATALOGO.unidades_sugeridas

const NATURALEZAS=["increment","cumulative","instantaneous","state"]

// Cómo entrega su valor un equipo en los usos de conteo:
//   pulses         ya es lo contado; se emite tal cual
//   running_total  total corrido; se emite la diferencia con la lectura anterior
// "increment" es el nombre antiguo de pulses y se acepta al cargar un flujo viejo.
const MODOS_CONTADOR=["pulses","running_total"]

// Los tramos de conteo cero son los de un umbral eq 0 sobre el incremento. El
// concentrador los reconoce por la expresión, no por el nombre; el nombre es el
// que propone el editor.
const NOMBRE_UMBRAL_CONTEO_CERO="zero_count"

function vacio(valor){
 return valor===undefined || valor===null || valor===""
}

/*=========================================================
=            IDENTIFICADORES (spec 007)
=========================================================*/

// device_uuid y variable_uuid son uuid v4 canónicos en minúsculas, obligatorios
// y estables (RN1-RN3). Es la misma expresión que aplica el concentrador
// (spec 042 del backend, RN1): una sola fuente para el editor, el runtime y el
// script de asignación.
const PATRON_UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function esUuidV4(texto){
 return typeof texto==="string" && PATRON_UUID_V4.test(texto)
}

// Recorta y pasa a minúsculas. No inventa un uuid si el texto no es válido:
// eso es cosa de nuevoUuidV4(), a petición explícita del técnico (CA5).
function normalizarUuid(texto){
 if(typeof texto!=="string") return texto
 return texto.trim().toLowerCase()
}

/*=========================================================
=            ALARMAS: CATÁLOGO Y UUID (spec 010)
=========================================================*/

// Toda alarma dice qué nodo la generó (catalog) y se identifica con un
// alarm_uuid: un uuid v4 que el técnico genera una vez (alarm-generator) o uno de
// los nueve reservados de las alarmas conocidas, con la forma
// 00000000-0000-0000-<catálogo>-<n>, donde el catálogo es 0001 en
// module-production y 0002 en modbus-variable. No son uuid v4: por eso la
// validación de una alarma acepta las dos formas, cada una con su catálogo.
// Los nombres no se traducen: forman parte del contrato (C-01 v3).
const CATALOGOS_DE_ALARMA=["module-production","modbus-variable","alarm-generator"]
const SEVERIDADES=["info","warning","critical"]
const SEVERIDAD_POR_DEFECTO="warning"

// Intervalo de muestra de module-production (segundos): los divisores de 60.
const INTERVALOS_DE_MUESTRA=[1,2,3,4,5,6,10,12,15,20,30,60]

const CODIGO_DE_CATALOGO={"module-production":"0001","modbus-variable":"0002"}

const NOMBRES_RESERVADOS={
 "module-production":[
  "SENSOR DE CONTEO DESALINEADO",
  "SENSOR DE PRESENCIA DESCONECTADO",
  "SENSOR DE CONTEO BLOQUEADO",
  "SENSOR DE PRESENCIA DESALINEADO",
  "FALLA SENSOR DE CONTEO 1",
  "FALLA SENSOR DE CONTEO 2"
 ],
 "modbus-variable":[
  "DEVICE OFFLINE",
  "READ TIMEOUT",
  "RTU CRC ERROR"
 ]
}

function uuidReservado(catalog,n){
 return "00000000-0000-0000-"+CODIGO_DE_CATALOGO[catalog]+"-"+String(n).padStart(12,"0")
}

// Las nueve alarmas conocidas: {catalog, n, alarm_name, alarm_uuid}.
const ALARMAS_RESERVADAS=[]

Object.keys(NOMBRES_RESERVADOS).forEach(function(catalog){
 NOMBRES_RESERVADOS[catalog].forEach(function(nombre,i){
  ALARMAS_RESERVADAS.push({catalog:catalog,n:i+1,alarm_name:nombre,alarm_uuid:uuidReservado(catalog,i+1)})
 })
})

function alarmaReservada(catalog,n){
 return ALARMAS_RESERVADAS.find(function(a){ return a.catalog===catalog && a.n===n })||null
}

function esUuidReservado(texto){
 return typeof texto==="string" && ALARMAS_RESERVADAS.some(function(a){ return a.alarm_uuid===texto })
}

// ¿Es un alarm_uuid válido para ese catálogo? Un reservado solo en el catálogo
// al que pertenece; alarm-generator, siempre un uuid v4 propio.
function esUuidDeAlarma(texto,catalog){

 if(!CATALOGOS_DE_ALARMA.includes(catalog)) return false
 if(catalog==="alarm-generator") return esUuidV4(texto)

 return ALARMAS_RESERVADAS.some(function(a){ return a.catalog===catalog && a.alarm_uuid===texto })

}

// Genera un uuid v4 nuevo. En Node usa crypto.randomUUID (con randomBytes como
// respaldo); en el navegador, crypto.randomUUID si el contexto es seguro y, si
// no (el editor se abre por http://<ip>:1880), crypto.getRandomValues, que sí
// existe fuera de un contexto seguro.
function bytesAUuid(bytes){

 bytes[6]=(bytes[6] & 0x0f) | 0x40
 bytes[8]=(bytes[8] & 0x3f) | 0x80

 let hex=""
 for(let i=0;i<bytes.length;i++){
  hex+=bytes[i].toString(16).padStart(2,"0")
 }

 return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20)

}

function nuevoUuidV4(){

 if(esNode){

  const nodeCrypto=require("crypto")

  if(typeof nodeCrypto.randomUUID==="function") return nodeCrypto.randomUUID()

  return bytesAUuid(Uint8Array.from(nodeCrypto.randomBytes(16)))

 }

 if(typeof crypto!=="undefined" && typeof crypto.randomUUID==="function"){
  return crypto.randomUUID()
 }

 let bytes=new Uint8Array(16)
 crypto.getRandomValues(bytes)

 return bytesAUuid(bytes)

}

// Pares (device_uuid, variable_uuid) repetidos, sumando todos los nodos que
// declaran ese device_uuid (RN4). `items`: [{device_uuid, variable_uuid, name}].
// Ignora entradas sin los dos identificadores: eso ya lo señala esUuidV4 aparte.
function duplicadosPorDispositivo(items){

 let porDispositivo={}

 ;(items||[]).forEach(function(it){

  if(vacio(it.device_uuid) || vacio(it.variable_uuid)) return

  if(!porDispositivo[it.device_uuid]) porDispositivo[it.device_uuid]={}
  if(!porDispositivo[it.device_uuid][it.variable_uuid]) porDispositivo[it.device_uuid][it.variable_uuid]=[]

  porDispositivo[it.device_uuid][it.variable_uuid].push(it)

 })

 let duplicados=[]

 for(let device_uuid in porDispositivo){
  for(let variable_uuid in porDispositivo[device_uuid]){

   let entradas=porDispositivo[device_uuid][variable_uuid]

   if(entradas.length>1){
    duplicados.push({device_uuid:device_uuid,variable_uuid:variable_uuid,items:entradas})
   }

  }
 }

 return duplicados

}

// Un mismo device_uuid con más de un device_name en el espacio de trabajo: se
// avisa (E5, CA6), sin invalidar nada (E6: dos nodos del mismo equipo comparten
// device_uuid a propósito). `items`: [{device_uuid, device_name}].
function dispositivosConNombresDistintos(items){

 let nombresPorDispositivo={}

 ;(items||[]).forEach(function(it){

  if(vacio(it.device_uuid)) return

  let nombre=it.device_name||""

  if(!nombresPorDispositivo[it.device_uuid]) nombresPorDispositivo[it.device_uuid]=[]
  if(nombresPorDispositivo[it.device_uuid].indexOf(nombre)===-1){
   nombresPorDispositivo[it.device_uuid].push(nombre)
  }

 })

 let conflictos=[]

 for(let device_uuid in nombresPorDispositivo){

  let nombres=nombresPorDispositivo[device_uuid]

  if(nombres.length>1){
   conflictos.push({device_uuid:device_uuid,device_name:nombres})
  }

 }

 return conflictos

}

/*=========================================================
=            CATÁLOGO DE USOS
=========================================================*/

function usoPorCodigo(codigo){
 return USOS.find(function(u){ return u.usage===codigo })||null
}

// El par (nature, role) es único en el catálogo. role vacío = sin papel.
function usoDeNaturalezaYPapel(nature,role){

 let papel=vacio(role) ? null : role

 return USOS.find(function(u){
  return u.nature===nature && (u.role||null)===papel
 })||null

}

// El uso con el que se comporta una configuración:
//   - con usage declarado, ese (o null si no existe en el catálogo);
//   - sin usage, el que se deduce de nature/role guardados por versiones anteriores
//     (un flujo viejo sigue funcionando sin tocarlo);
//   - sin nada de eso, null: la variable no está declarada.
function usoDeVariable(config){

 if(!vacio(config.usage)) return usoPorCodigo(config.usage)

 if(!vacio(config.nature)) return usoDeNaturalezaYPapel(config.nature,config.role)

 return null

}

function modoDeContador(modo){
 return modo==="increment" ? "pulses" : modo
}

/*=========================================================
=            UMBRALES
=========================================================*/

// Un solo vocabulario para los dos nodos. Sin prioridad ni histéresis.
// between = dentro de la banda; "fuera de ±5 %" son dos umbrales lt/gt.
const CONDICIONES=["gt","gte","eq","lte","lt","between"]

// Los símbolos son el vocabulario antiguo de module-production.
const CONDICION_POR_SIMBOLO={
 ">":"gt",">=":"gte","=":"eq","==":"eq","<=":"lte","<":"lt","><":"between"
}

function normalizarCondicion(condicion){
 if(CONDICIONES.includes(condicion)) return condicion
 return CONDICION_POR_SIMBOLO[condicion]||condicion
}

// ¿Cumple el valor el umbral? Acepta el vocabulario antiguo por robustez.
function evaluarUmbral(valor,umbral){

 let v1=Number(umbral.value)
 let v2=Number(umbral.value2)

 switch(normalizarCondicion(umbral.condition)){

  case "gt": return valor>v1
  case "gte": return valor>=v1
  case "lt": return valor<v1
  case "lte": return valor<=v1
  case "eq": return valor===v1
  case "between": return valor>=v1 && valor<=v2
  default: return false

 }

}

// ¿Sigue cumpliéndose el umbral una vez activa la alarma? Es la condición
// ampliada con el «margen para apagar» (spec 010, D8): en gt y gte el margen se
// resta del límite, en lt y lte se suma, y en between se aplica por los dos lados.
// En eq no se aplica. Con margen 0 es la condición tal cual. Es un número sin
// unidad propia: usa la de la variable.
function evaluarUmbralConMargen(valor,umbral,margen){

 let m=Number(margen)

 if(!(m>0)) return evaluarUmbral(valor,umbral)

 let v1=Number(umbral.value)
 let v2=Number(umbral.value2)

 switch(normalizarCondicion(umbral.condition)){

  case "gt":
  case "gte": return valor>=v1-m
  case "lt":
  case "lte": return valor<=v1+m
  case "between": return valor>=v1-m && valor<=v2+m
  default: return evaluarUmbral(valor,umbral)

 }

}

function esNumero(valor){
 return !vacio(valor) && Number.isFinite(Number(valor))
}

// Umbral tal como se guarda: solo los campos del vocabulario común. value2 solo
// existe con between.
function umbralGuardable(umbral){

 let condicion=normalizarCondicion(umbral.condition)

 let salida={
  name:umbral.name,
  condition:condicion,
  value:umbral.value
 }

 if(condicion==="between") salida.value2=umbral.value2

 return salida

}

// El umbral de conteo cero que el editor añade, bloqueado, al elegir
// production_count.
function umbralConteoCero(){
 return {name:NOMBRE_UMBRAL_CONTEO_CERO,condition:"eq",value:0}
}

function esUmbralConteoCero(umbral){
 return !!umbral && normalizarCondicion(umbral.condition)==="eq" && esNumero(umbral.value) && Number(umbral.value)===0
}

function validarUmbrales(umbrales){

 let errores=[]
 let nombres={}

 ;(Array.isArray(umbrales) ? umbrales : []).forEach(function(u,i){

  if(!u || vacio(u.name)){
   errores.push("el umbral n.º "+(i+1)+" no tiene nombre")
   return
  }

  if(nombres[u.name]){
   errores.push('el umbral "'+u.name+'" está repetido; cada umbral de la variable lleva un nombre distinto')
  }

  nombres[u.name]=true

  if(!CONDICIONES.includes(u.condition)){
   errores.push('el umbral "'+u.name+'" usa la condición "'+u.condition+'"; admitidas: '+CONDICIONES.join(", "))
   return
  }

  if(!esNumero(u.value)){
   errores.push('el umbral "'+u.name+'" necesita un valor numérico')
  }

  if(u.condition==="between" && !esNumero(u.value2)){
   errores.push('el umbral "'+u.name+'" (between) necesita un segundo valor numérico')
  }

  if(u.name===NOMBRE_UMBRAL_CONTEO_CERO && !esUmbralConteoCero(u)){
   errores.push('el umbral "'+NOMBRE_UMBRAL_CONTEO_CERO+'" marca los tramos de conteo cero: su condición tiene que ser eq con valor 0')
  }

 })

 return errores

}

// Umbral tal como viaja en el mensaje de una variable hacia su reporter:
// condición en código y sin campos que no son del vocabulario (la prioridad de
// versiones anteriores no se usa en ninguna parte).
function umbralesParaMensaje(umbrales){
 return (Array.isArray(umbrales) ? umbrales : []).map(umbralGuardable)
}

/*=========================================================
=            VALIDACIÓN
=========================================================*/

// Motivos por los que la configuración de una variable no es válida. Lista
// vacía = válida. Una variable sin uso declarado NO es válida: no se emite.

function validarVariable(config){

 let errores=[]

 let uso=usoDeVariable(config)

 if(vacio(config.usage) && vacio(config.nature)){
  errores.push("falta declarar el uso de la variable")
 }else if(!uso){
  if(!vacio(config.usage)){
   errores.push('el uso "'+config.usage+'" no existe; usos admitidos: '+USOS.map(function(u){ return u.usage }).join(", "))
  }else{
   errores.push('la combinación nature "'+config.nature+'" y role "'+(config.role||"")+'" no corresponde a ningún uso del catálogo')
  }
 }else if(!vacio(config.usage) && !vacio(config.nature)
   && (config.nature!==uso.nature || (config.role||null)!==(uso.role||null))){
  errores.push('nature/role guardados no coinciden con el uso "'+uso.usage+'"; el uso manda, vuelve a guardar la variable')
 }

 let modo=modoDeContador(config.counter_mode)

 if(uso && uso.totalizer){

  if(vacio(modo)){
   errores.push('un uso de conteo exige elegir cómo entrega el valor el equipo: "pulses" si el registro ya es lo contado, o "running_total" si es un total corrido que hay que convertir')
  }else if(!MODOS_CONTADOR.includes(modo)){
   errores.push('la lectura del conteo "'+config.counter_mode+'" no existe; valores admitidos: '+MODOS_CONTADOR.join(", "))
  }

 }else if(uso && !vacio(modo)){
  errores.push("la lectura del conteo (counter_mode) solo se admite en los usos de conteo")
 }

 return errores.concat(validarUmbrales(config.thresholds))

}

function esValida(config){
 return validarVariable(config).length===0
}

// Lo que el uso exige y no es un valor inválido: el umbral de conteo cero del
// conteo de producción. Sin él la variable se resume igual de bien, pero nadie
// sabrá nunca en qué segundos dejó de contar: su línea no aparecerá parada
// jamás. El editor lo añade solo; si un flujo antiguo no lo trae, el editor lo
// marca y el runtime lo avisa, pero la variable se sigue emitiendo entera.
function avisosDeConfiguracion(config){

 let uso=usoDeVariable(config)

 if(!uso || !uso.zero_count) return []

 let umbrales=Array.isArray(config.thresholds) ? config.thresholds : []

 if(umbrales.some(esUmbralConteoCero)) return []

 return ['el uso "'+uso.usage+'" exige el umbral "'+NOMBRE_UMBRAL_CONTEO_CERO+'" (condición eq con valor 0): sin él no se sabe en qué segundos dejó de contar y su línea no aparecerá parada nunca']

}

// Unidad fuera de la lista sugerida: se acepta (texto libre), pero se avisa.
function unidadFueraDeLista(unidad){
 return !vacio(unidad) && !UNIDADES_SUGERIDAS.includes(unidad)
}

/*=========================================================
=            LO QUE SE EMITE
=========================================================*/

// Campos del paquete que salen del uso. usage no viaja; counter_mode tampoco: es
// configuración de la lectura, no de la señal.
function camposDeVariable(config){

 if(!esValida(config)) return {}

 let uso=usoDeVariable(config)
 let campos={nature:uso.nature}

 if(uso.role) campos.role=uso.role

 return campos

}

/*=========================================================
=            CARGAR Y GUARDAR UNA VARIABLE (editor)
=========================================================*/

// Los campos que el formulario común reconoce y los que sustituye el uso. Están
// aquí, junto a las reglas, para que una prueba compruebe que cargar y guardar
// un flujo no pierde ningún campo.
const CAMPOS_DE_VARIABLE=["name","variable_uuid","unit","usage","counter_mode","thresholds"]
const CAMPOS_SUSTITUIDOS_POR_EL_USO=["type","nature","role"]

// Lo que el formulario muestra para una variable guardada. Deduce el uso de lo
// guardado por versiones anteriores y adopta los nombres nuevos, sin inventar
// nada: sin uso deducible, usage queda vacío y la variable sale en rojo.
function cargarVariable(guardada){

 let modelo=Object.assign({},guardada)

 let uso=usoDeVariable(guardada)

 modelo.usage=uso ? uso.usage : (vacio(guardada.usage) ? "" : guardada.usage)

 CAMPOS_SUSTITUIDOS_POR_EL_USO.forEach(function(k){ delete modelo[k] })

 if(!vacio(modelo.counter_mode)) modelo.counter_mode=modoDeContador(modelo.counter_mode)

 modelo.thresholds=(guardada.thresholds||[]).map(function(u){

  let umbral=Object.assign({},u)
  umbral.condition=normalizarCondicion(u.condition)
  delete umbral.priority

  return umbral

 })

 return modelo

}

// Lo que se guarda a partir del formulario: la misma forma que cargarVariable,
// más el umbral de conteo cero cuando el uso lo exige y sin lectura de conteo
// donde no aplica.
function guardarVariable(modelo){

 let guardada=Object.assign({},modelo)

 let uso=usoPorCodigo(modelo.usage)

 CAMPOS_SUSTITUIDOS_POR_EL_USO.forEach(function(k){ delete guardada[k] })

 if(uso && uso.totalizer){
  guardada.counter_mode=modoDeContador(modelo.counter_mode)||""
 }else{
  delete guardada.counter_mode
 }

 let umbrales=umbralesParaMensaje(modelo.thresholds)

 // El umbral de conteo cero es automático: si el uso lo exige y no está, se
 // añade; si el uso ya no lo exige, el automático se retira.
 if(uso && uso.zero_count){
  if(!umbrales.some(esUmbralConteoCero)) umbrales.unshift(umbralConteoCero())
 }else{
  umbrales=umbrales.filter(function(u){
   return !(u.name===NOMBRE_UMBRAL_CONTEO_CERO && esUmbralConteoCero(u))
  })
 }

 guardada.thresholds=umbrales

 return guardada

}

/*=========================================================
=            COMPATIBILIDAD CON LOS NODOS ANTERIORES
=========================================================*/

// modbus-variable y module-production, tal como los dejan los parches 001-005,
// todavía piden estas cuatro cosas. Mientras no se apliquen los cambios que los
// sustituyen (el «uso» en modbus-variable y en module-production, y el reporter
// sin type), siguen funcionando. Cuando ya estén aplicados, este bloque se puede
// borrar: nada de lo nuevo lo usa.

// type que se emitía mientras convivían paquetes con y sin nature.
const TIPO_POR_NATURALEZA={
 increment:"counter",
 cumulative:"instantaneous",
 instantaneous:"instantaneous",
 state:"state"
}

function tipoDeConvivencia(config){

 if(NATURALEZAS.includes(config.nature)) return TIPO_POR_NATURALEZA[config.nature]

 return vacio(config.type) ? "instantaneous" : config.type

}

// Los papeles que existen: los del catálogo.
const PAPELES_VIGENTES=USOS.filter(function(u){ return !!u.role }).map(function(u){ return u.role })

// El papel de un sensor con su naturaleza: existe y va con esa naturaleza.
function validarPapel(config){

 let role=config.role
 if(vacio(role)) return []

 if(!PAPELES_VIGENTES.includes(role)){
  return ['el papel "'+role+'" no existe; papeles admitidos: '+PAPELES_VIGENTES.join(", ")]
 }

 if(vacio(config.nature)){
  return ['el papel "'+role+'" exige declarar la naturaleza de la variable']
 }

 if(!usoDeNaturalezaYPapel(config.nature,role)){
  return ['el papel "'+role+'" no admite la naturaleza "'+config.nature+'"']
 }

 return []

}

/*=========================================================
=            TOTAL CORRIDO -> INCREMENTO
=========================================================*/

// convertir(lectura) devuelve {valor, motivo}:
//   primera   sin lectura previa: valor null, no se emite muestra (un 0 abriría
//             un tramo de conteo cero falso)
//   avance    valor = lectura - anterior
//   reinicio  la lectura bajó: el contador se reinició y la lectura nueva cuenta entera
//   invalida  lectura no numérica: valor null y la base no se mueve
//
// Los enteros de 64 bits llegan como cadena y se restan como BigInt.

const ENTERO=/^-?\d+$/

function normalizarLectura(lectura){

 if(typeof lectura==="bigint") return lectura
 if(typeof lectura==="number") return Number.isFinite(lectura) ? lectura : null

 if(typeof lectura==="string"){
  let texto=lectura.trim()
  if(ENTERO.test(texto)) return BigInt(texto)
  if(texto!==""){
   let numero=Number(texto)
   return Number.isFinite(numero) ? numero : null
  }
 }

 return null

}

function restar(a,b){
 if(typeof a==="bigint" && typeof b==="bigint") return Number(a-b)
 return Number(a)-Number(b)
}

function crearConversorTotalCorrido(){

 let anterior=null

 return {

  convertir(lectura){

   let actual=normalizarLectura(lectura)
   if(actual===null) return {valor:null,motivo:"invalida"}

   let previa=anterior
   anterior=actual

   if(previa===null) return {valor:null,motivo:"primera"}
   if(actual<previa) return {valor:Number(actual),motivo:"reinicio"}
   return {valor:restar(actual,previa),motivo:"avance"}

  },

  reiniciar(){
   anterior=null
  }

 }

}

// Todo lo que modbus-variable necesita saber de una secuencia, en una llamada.
// Una configuración inválida no se emite (errores dice por qué).
function describirVariable(config){

 let errores=validarVariable(config)
 let valida=errores.length===0
 let uso=usoDeVariable(config)

 return {
  errores:errores,
  avisos:avisosDeConfiguracion(config),
  usage:uso ? uso.usage : null,
  campos:camposDeVariable(config),
  convierteTotalCorrido:valida && !!uso && uso.totalizer && modoDeContador(config.counter_mode)==="running_total"
 }

}

/*=========================================================
=            NODO DE PRODUCCIÓN (module-production)
=========================================================*/

// Cada sensor de module-production es una variable con los mismos campos que una
// secuencia de modbus-variable, guardados con prefijo: sc1_name, uuid_sc1,
// sc1_unit, sc1_usage, sc1_thresholds. Los flujos anteriores traían un papel
// (sc1_role) y una lista de umbrales común con un "target" (sc1/sc2) y
// condiciones con símbolos: esta función los traduce a la forma nueva, y la usan
// el runtime y el editor, así que un flujo sin tocar sigue funcionando.
const SENSORES_DE_CONTEO=["sc1","sc2"]

const NOMBRE_POR_SENSOR={sc1:"SENSOR DE CONTEO 1",sc2:"SENSOR DE CONTEO 2",sp:"SENSOR DE PRESENCIA"}

function variableDeSensor(config,sensor){

 let nombre=config[sensor+"_name"]

 let variable={
  name:vacio(nombre) ? NOMBRE_POR_SENSOR[sensor] : nombre,
  variable_uuid:config["uuid_"+sensor]
 }

 // La presencia es solo un estado: sin unidad ni umbrales.
 if(sensor==="sp"){
  variable.usage="state"
  return variable
 }

 let unidad=config[sensor+"_unit"]
 variable.unit=vacio(unidad) ? "pulses" : unidad

 let usage=config[sensor+"_usage"]

 if(vacio(usage)){
  // Un flujo anterior: solo traía el papel, y un sensor de conteo siempre fue un
  // increment. Con papel, el uso se deduce; sin papel no se inventa ninguno (un
  // nodo nuevo tampoco lo tiene): sin uso, el sensor no se reporta y sale en rojo.
  let papel=config[sensor+"_role"]
  let uso=vacio(papel) ? null : usoDeNaturalezaYPapel("increment",papel)
  usage=uso ? uso.usage : ""
 }

 variable.usage=usage

 // Los umbrales propios del sensor; si no tiene (un flujo anterior, o el editor
 // que rellena el campo vacío), los de la lista común antigua que apuntaban a él.
 let umbrales=config[sensor+"_thresholds"]

 if(!Array.isArray(umbrales) || umbrales.length===0){
  umbrales=(Array.isArray(config.thresholds) ? config.thresholds : [])
   .filter(function(t){ return t && t.target===sensor })
 }

 variable.thresholds=umbrales.map(function(t){

  let umbral=Object.assign({},t)

  delete umbral.target
  delete umbral.priority

  umbral.condition=normalizarCondicion(t.condition)

  return umbral

 })

 // Un sensor GPIO cuenta pulsos: es lo contado dentro de la ventana.
 variable.counter_mode="pulses"

 return variable

}

// Lo que module-production guarda de un sensor a partir de la variable ya
// preparada por guardarVariable(): la misma forma plana que lee variableDeSensor.
function camposDeSensor(sensor,variable){

 if(sensor==="sp"){
  return {sp_name:variable.name,uuid_sp:variable.variable_uuid}
 }

 let campos={}

 campos[sensor+"_name"]=variable.name
 campos["uuid_"+sensor]=variable.variable_uuid
 campos[sensor+"_unit"]=variable.unit
 campos[sensor+"_usage"]=variable.usage
 campos[sensor+"_thresholds"]=variable.thresholds

 return campos

}

// Campos de module-production que existían antes del uso de la variable. Se
// siguen declarando en el nodo para que el editor pueda leer lo guardado y
// deducir el uso, y al guardar quedan vacíos: lo sustituyen sc1_usage,
// sc1_thresholds y sus equivalentes. report_interval ya no existe.
const CAMPOS_HEREDADOS_DE_PRODUCCION={sc1_role:"",sc2_role:"",thresholds:[]}

// Motivos por los que un sensor de conteo de module-production no es válido:
// las reglas de toda variable y, además, que su uso sea de conteo.
function validarSensorDeConteo(variable){

 let errores=[]
 let uso=usoPorCodigo(variable.usage)

 if(uso && uso.nature!=="increment"){
  errores.push('un sensor de conteo solo admite usos de conteo (nature increment); "'+uso.usage+'" es '+uso.nature)
 }

 return errores.concat(validarVariable(variable))

}

return {
 PATRON_UUID_V4:PATRON_UUID_V4,
 esUuidV4:esUuidV4,
 CATALOGOS_DE_ALARMA:CATALOGOS_DE_ALARMA,
 SEVERIDADES:SEVERIDADES,
 INTERVALOS_DE_MUESTRA:INTERVALOS_DE_MUESTRA,
 SEVERIDAD_POR_DEFECTO:SEVERIDAD_POR_DEFECTO,
 ALARMAS_RESERVADAS:ALARMAS_RESERVADAS,
 alarmaReservada:alarmaReservada,
 esUuidReservado:esUuidReservado,
 esUuidDeAlarma:esUuidDeAlarma,
 normalizarUuid:normalizarUuid,
 nuevoUuidV4:nuevoUuidV4,
 duplicadosPorDispositivo:duplicadosPorDispositivo,
 dispositivosConNombresDistintos:dispositivosConNombresDistintos,
 USOS:USOS,
 UNIDADES_SUGERIDAS:UNIDADES_SUGERIDAS,
 NATURALEZAS:NATURALEZAS,
 TIPO_POR_NATURALEZA:TIPO_POR_NATURALEZA,
 PAPELES_VIGENTES:PAPELES_VIGENTES,
 MODOS_CONTADOR:MODOS_CONTADOR,
 CONDICIONES:CONDICIONES,
 NOMBRE_UMBRAL_CONTEO_CERO:NOMBRE_UMBRAL_CONTEO_CERO,
 CAMPOS_DE_VARIABLE:CAMPOS_DE_VARIABLE,
 CAMPOS_SUSTITUIDOS_POR_EL_USO:CAMPOS_SUSTITUIDOS_POR_EL_USO,
 SENSORES_DE_CONTEO:SENSORES_DE_CONTEO,
 usoPorCodigo:usoPorCodigo,
 usoDeNaturalezaYPapel:usoDeNaturalezaYPapel,
 usoDeVariable:usoDeVariable,
 normalizarCondicion:normalizarCondicion,
 evaluarUmbral:evaluarUmbral,
 evaluarUmbralConMargen:evaluarUmbralConMargen,
 umbralConteoCero:umbralConteoCero,
 esUmbralConteoCero:esUmbralConteoCero,
 umbralesParaMensaje:umbralesParaMensaje,
 validarUmbrales:validarUmbrales,
 avisosDeConfiguracion:avisosDeConfiguracion,
 validarVariable:validarVariable,
 validarPapel:validarPapel,
 tipoDeConvivencia:tipoDeConvivencia,
 unidadFueraDeLista:unidadFueraDeLista,
 camposDeVariable:camposDeVariable,
 cargarVariable:cargarVariable,
 guardarVariable:guardarVariable,
 crearConversorTotalCorrido:crearConversorTotalCorrido,
 describirVariable:describirVariable,
 variableDeSensor:variableDeSensor,
 camposDeSensor:camposDeSensor,
 CAMPOS_HEREDADOS_DE_PRODUCCION:CAMPOS_HEREDADOS_DE_PRODUCCION,
 validarSensorDeConteo:validarSensorDeConteo
}

})
