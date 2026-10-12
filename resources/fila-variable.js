/*=========================================================
=            FILA DE VARIABLE (componente común del editor)
=========================================================*/

// El formulario de una variable, igual en los dos nodos: nombre, uuid, unidad,
// uso, lectura del conteo (solo en los usos de conteo) y umbrales. modbus-variable
// lo pone en cada fila de su lista y module-production, en cada sensor.
//
// Solo dibuja y lee el formulario. Las reglas (qué usos hay, qué exige cada uno,
// qué se guarda) viven en naturaleza-variable.js, que se carga antes.
//
//   var fila=MentorFilaVariable.crear($contenedor,datosGuardados,opciones)
//   fila.leer()   -> {name, variable_uuid, unit, usage, counter_mode, thresholds}
//
// opciones:
//   usos        function(uso) -> bool: qué usos se ofrecen (por defecto todos)
//   usoFijo     código de un uso que no se elige (la presencia es siempre "state")
//   conUnidad   false para no pedir unidad (por defecto sí)
//   conModo     true para pedir cómo entrega el valor el equipo (Modbus)
//   conUmbrales false para no admitir umbrales (por defecto sí)
//   nombre      texto de la etiqueta del nombre (por defecto «Nombre»)
//   antesDeUmbrales  function($contenedor): el nodo añade aquí sus propios campos
//               (la lectura Modbus), entre el uso y los umbrales
//   t           function(clave, variables): traduce un texto del formulario con el
//               catálogo del nodo (clave sin prefijo: «nombre», «cond.gt»…). Sin ella
//               se usan los textos en inglés de abajo (spec 010, D15). Los datos —los
//               nombres de las alarmas y de los umbrales, los códigos de condición—
//               no se traducen.

(function(raiz){

"use strict"

var reglas=raiz.MentorNaturalezaVariable
var contador=0

var TEXTOS={
 "name":"Name",
 "variableUuid":"Variable UUID",
 "generate":"Generate",
 "unit":"Unit",
 "unitWarning":"This unit is not in the suggested list. It is accepted as free text; check that it is spelled correctly.",
 "usage":"Usage",
 "chooseUsage":"— choose the usage —",
 "fixed":"(fixed)",
 "notValidHere":"__usage__ (not valid here)",
 "reading":"Reading",
 "choose":"— choose —",
 "mode.pulses":"Pulses (the register already is what was counted)",
 "mode.running_total":"Running total (the capturer subtracts the previous reading)",
 "cond.gt":"Greater (>)",
 "cond.gte":"Greater or equal (>=)",
 "cond.eq":"Equal (=)",
 "cond.lte":"Less or equal (<=)",
 "cond.lt":"Less (<)",
 "cond.between":"Between (inside the band)",
 "thresholds":"Thresholds (__count__)",
 "addThreshold":"+ add threshold",
 "thresholdName":"Name",
 "value":"Value",
 "value2":"Value 2",
 "locked":"🔒 automatic",
 "lockedTitle":"Added by the usage «Production count»; it marks the seconds without counting"
}

var MODOS_ORDEN=["pulses","running_total"]
var CONDICIONES_ORDEN=["gt","gte","eq","lte","lt","between"]

function crear(contenedor,datos,opciones){

 var $=raiz.jQuery
 opciones=opciones||{}
 datos=datos||{}

 // Texto traducido: el catálogo del nodo si lo hay y, si no, el inglés de arriba.
 function t(clave,variables,porDefecto){

  var texto=opciones.t ? opciones.t(clave,variables) : undefined

  if(texto===undefined || texto===null || texto==="" || texto===clave || /\.fila\./.test(String(texto))){
   texto=porDefecto!==undefined ? porDefecto : TEXTOS[clave]
   if(texto===undefined) texto=clave
   Object.keys(variables||{}).forEach(function(k){ texto=texto.replace("__"+k+"__",variables[k]) })
  }

  return texto

 }

 var id=++contador
 var conUnidad=opciones.conUnidad!==false
 var conUmbrales=opciones.conUmbrales!==false
 var permitido=opciones.usos||function(){ return true }

 // El nombre del uso: la clave usage.<código> del catálogo del nodo y, si no está,
 // la etiqueta que trae usos.json.
 function etiquetaDeUso(u){
  var texto=opciones.t ? opciones.t("usos."+u.usage) : undefined
  return (texto===undefined || texto===null || texto==="" || /\.fila\.|usos\./.test(String(texto))) ? u.label : texto
 }

 function fila(clase){
  return $("<div/>",{class:"form-row "+(clase||"")}).appendTo(contenedor)
 }

 /*---------------- nombre y uuid ----------------*/

 var rNombre=fila()
 $("<label/>").text(opciones.nombre||t("name")).appendTo(rNombre)
 var nombre=$("<input/>",{type:"text",class:"mfv-nombre"}).appendTo(rNombre)

 var rUuid=fila()
 $("<label/>").text(t("variableUuid")).appendTo(rUuid)
 var uuid=$("<input/>",{type:"text",class:"mfv-uuid",style:"width:60%"}).appendTo(rUuid)
 var generar=$("<button/>",{type:"button",class:"red-ui-button mfv-generar",style:"margin-left:6px"})
  .text(t("generate")).appendTo(rUuid)

 generar.on("click",function(e){
  e.preventDefault()
  uuid.val(reglas.nuevoUuidV4())
 })

 /*---------------- unidad ----------------*/

 var unidad=null
 var avisoUnidad=null

 if(conUnidad){

  var rUnidad=fila()
  $("<label/>").text(t("unit")).appendTo(rUnidad)

  var idLista="mfv-unidades-"+id

  unidad=$("<input/>",{type:"text",class:"mfv-unidad",list:idLista}).appendTo(rUnidad)

  var lista=$("<datalist/>",{id:idLista}).appendTo(rUnidad)

  reglas.UNIDADES_SUGERIDAS.forEach(function(u){
   lista.append($("<option/>").val(u))
  })

  avisoUnidad=$("<div/>",{class:"form-tips mfv-aviso-unidad",style:"display:none;margin-top:4px"})
   .text(t("unitWarning"))
   .appendTo(fila())

  unidad.on("input change",function(){
   avisoUnidad.toggle(reglas.unidadFueraDeLista(unidad.val()))
  })

 }

 /*---------------- uso ----------------*/

 var rUso=fila()
 $("<label/>").text(t("usage")).appendTo(rUso)

 var uso=null
 var textoFijo=null

 if(opciones.usoFijo){

  var usoFijo=reglas.usoPorCodigo(opciones.usoFijo)
  textoFijo=$("<span/>",{class:"mfv-uso-fijo"}).text((usoFijo ? etiquetaDeUso(usoFijo) : opciones.usoFijo)+" "+t("fixed")).appendTo(rUso)

 }else{

  uso=$("<select/>",{class:"mfv-uso"}).appendTo(rUso)

  uso.append($("<option/>").val("").text(t("chooseUsage")))

  reglas.USOS.filter(permitido).forEach(function(u){
   uso.append($("<option/>").val(u.usage).text(etiquetaDeUso(u)))
  })

  // Un uso guardado que este editor no ofrece (o que ya no existe) no se
  // esconde ni se cambia en silencio: se muestra marcado, para que el técnico
  // lo vea y elija.
  var guardado=datos.usage
  if(guardado && !uso.find("option").filter(function(){ return this.value===guardado }).length){
   uso.append($("<option/>").val(guardado).text("⚠ "+t("notValidHere",{usage:guardado})))
  }

 }

 function usoActual(){
  return reglas.usoPorCodigo(opciones.usoFijo||(uso&&uso.val()))
 }

 /*---------------- lectura del conteo (Modbus) ----------------*/

 var rModo=null
 var modo=null

 if(opciones.conModo){

  rModo=fila("mfv-fila-modo")
  $("<label/>").text(t("reading")).appendTo(rModo)
  modo=$("<select/>",{class:"mfv-modo"}).appendTo(rModo)

  modo.append($("<option/>").val("").text(t("choose")))

  MODOS_ORDEN.forEach(function(m){
   modo.append($("<option/>").val(m).text(t("mode."+m)))
  })

 }

 if(opciones.antesDeUmbrales) opciones.antesDeUmbrales(contenedor)

 /*---------------- umbrales ----------------*/

 var umbrales=null
 var cabecera=null
 var listaUmbrales=null

 if(conUmbrales){

  umbrales=$("<div/>",{class:"mfv-umbrales",style:"margin-top:6px;border-top:1px solid #ddd;padding-top:6px"}).appendTo(contenedor)

  cabecera=$("<div/>",{class:"mfv-umbrales-cabecera",style:"cursor:pointer;font-weight:bold;color:#444;margin-bottom:5px"})
   .appendTo(umbrales)

  listaUmbrales=$("<div/>",{class:"mfv-umbrales-lista",style:"margin-left:10px"}).appendTo(umbrales).hide()

  var anadir=$("<button/>",{type:"button",class:"red-ui-button red-ui-button-small mfv-umbral-anadir",style:"margin:4px 0 0 10px"})
   .text(t("addThreshold")).appendTo(umbrales).hide()

  cabecera.on("click",function(){
   listaUmbrales.toggle()
   anadir.toggle(listaUmbrales.is(":visible"))
   actualizarCabecera()
  })

  anadir.on("click",function(e){
   e.preventDefault()
   filaUmbral({name:"",condition:"gt",value:"",value2:""},false)
  })

 }

 function actualizarCabecera(){
  if(!cabecera) return
  cabecera.text((listaUmbrales.is(":visible")?"▼ ":"▶ ")+t("thresholds",{count:listaUmbrales.children().length}))
 }

 function filaUmbral(datosUmbral,bloqueado){

  var r=$("<div/>",{class:"mfv-umbral",style:"display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px"})
   .appendTo(listaUmbrales)

  r.data("bloqueado",!!bloqueado)

  var nombreU=$("<input/>",{type:"text",class:"mfv-umbral-nombre",placeholder:t("thresholdName"),style:"width:140px"}).appendTo(r)
  var cond=$("<select/>",{class:"mfv-umbral-condicion",style:"width:170px"}).appendTo(r)

  CONDICIONES_ORDEN.forEach(function(c){
   cond.append($("<option/>").val(c).text(t("cond."+c)))
  })

  var v1=$("<input/>",{type:"number",step:"any",class:"mfv-umbral-v1",placeholder:t("value"),style:"width:80px"}).appendTo(r)
  var v2=$("<input/>",{type:"number",step:"any",class:"mfv-umbral-v2",placeholder:t("value2"),style:"width:80px"}).appendTo(r)

  nombreU.val(datosUmbral.name===undefined||datosUmbral.name===null ? "" : datosUmbral.name)
  cond.val(datosUmbral.condition||"gt")
  v1.val(datosUmbral.value===undefined||datosUmbral.value===null ? "" : datosUmbral.value)
  v2.val(datosUmbral.value2===undefined||datosUmbral.value2===null ? "" : datosUmbral.value2)

  function segundoValor(){
   v2.toggle(cond.val()==="between")
  }

  cond.on("change",segundoValor)
  segundoValor()

  if(bloqueado){

   nombreU.prop("disabled",true)
   cond.prop("disabled",true)
   v1.prop("disabled",true)
   v2.prop("disabled",true)

   $("<span/>",{class:"mfv-candado",title:t("lockedTitle")})
    .text(t("locked")).appendTo(r)

  }else{

   $("<button/>",{type:"button",class:"red-ui-button red-ui-button-small mfv-umbral-quitar"})
    .text("×").appendTo(r)
    .on("click",function(e){
     e.preventDefault()
     r.remove()
     actualizarCabecera()
    })

  }

  actualizarCabecera()

  return r

 }

 // El umbral de conteo cero es automático: lo añade el uso que lo exige y lo
 // retira el que ya no.
 function sincronizarConteoCero(){

  if(!listaUmbrales) return

  var u=usoActual()
  var automatico=listaUmbrales.children().filter(function(){ return $(this).data("bloqueado") })

  if(u && u.zero_count){

   if(!automatico.length){

    // El concentrador reconoce el conteo cero por su expresión (eq 0), no por el
    // nombre: si el técnico ya tenía un umbral igual, se sustituye por el
    // automático bloqueado en vez de duplicarlo.
    var existente=listaUmbrales.children().filter(function(){
     var f=$(this)
     return f.find(".mfv-umbral-condicion").val()==="eq"
      && f.find(".mfv-umbral-v1").val()!==""
      && Number(f.find(".mfv-umbral-v1").val())===0
    })

    if(existente.length){
     existente.first().remove()
    }

    var fz=filaUmbral(reglas.umbralConteoCero(),true)
    listaUmbrales.prepend(fz)

   }

  }else{
   automatico.remove()
  }

  actualizarCabecera()

 }

 /*---------------- reacción al uso ----------------*/

 function alCambiarUso(){

  var u=usoActual()

  if(rModo){

   if(u && u.totalizer){
    rModo.show()
   }else{
    rModo.hide()
    modo.val("")
   }

  }

  sincronizarConteoCero()

 }

 if(uso) uso.on("change",alCambiarUso)

 /*---------------- carga ----------------*/

 nombre.val(datos.name||"")
 uuid.val(datos.variable_uuid||"")

 if(unidad){
  unidad.val(datos.unit||"")
  avisoUnidad.toggle(reglas.unidadFueraDeLista(unidad.val()))
 }

 if(uso) uso.val(datos.usage||"")

 if(modo) modo.val(datos.counter_mode||"")

 if(listaUmbrales){

  var yaAutomatico=false
  var usoInicial=usoActual()

  ;(datos.thresholds||[]).forEach(function(t){

   var esAutomatico=!yaAutomatico && !!usoInicial && !!usoInicial.zero_count && reglas.esUmbralConteoCero(t)

   if(esAutomatico) yaAutomatico=true

   filaUmbral(t,esAutomatico)

  })

  actualizarCabecera()

 }

 alCambiarUso()

 /*---------------- lectura ----------------*/

 function leer(){

  var u=usoActual()

  var modelo={
   name:nombre.val(),
   variable_uuid:reglas.normalizarUuid(uuid.val()),
   usage:u ? u.usage : (uso ? uso.val() : (opciones.usoFijo||"")),
   thresholds:[]
  }

  if(unidad) modelo.unit=unidad.val()

  if(modo && u && u.totalizer) modelo.counter_mode=modo.val()

  if(listaUmbrales){

   listaUmbrales.children().each(function(){

    var f=$(this)

    var t={
     name:f.find(".mfv-umbral-nombre").val(),
     condition:f.find(".mfv-umbral-condicion").val(),
     value:f.find(".mfv-umbral-v1").val()
    }

    if(t.condition==="between") t.value2=f.find(".mfv-umbral-v2").val()

    modelo.thresholds.push(t)

   })

  }

  return modelo

 }

 return {leer:leer}

}

raiz.MentorFilaVariable={crear:crear}

})(window)
