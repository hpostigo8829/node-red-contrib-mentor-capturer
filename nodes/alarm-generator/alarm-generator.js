module.exports = function (RED) {

    const naturaleza = require("../../resources/naturaleza-variable");

    // Valores por defecto de la histéresis (spec 010, D8).
    const ACTIVAR_S = 5;
    const APAGAR_S = 10;

    function AlarmGeneratorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // =========================
        // CONFIG
        // =========================
        // Un nodo vigila UN umbral de UNA variable: se elige por su variable_uuid y
        // el nombre del umbral (el editor los ofrece como desplegables a partir del
        // nodo conectado a la entrada). La alarma es suya: su nombre, su alarm_uuid
        // (un uuid v4 que se genera una vez) y su severidad.
        const VARIABLE_UUID = naturaleza.normalizarUuid(config.variable_uuid || "");
        const THRESHOLD_NAME = (config.threshold_name || "").trim();
        const ALARM_NAME = (config.alarm_name || "").trim();
        const ALARM_UUID = naturaleza.normalizarUuid(config.alarm_uuid || "");
        const SEVERITY = (config.severity === undefined || config.severity === "")
            ? naturaleza.SEVERIDAD_POR_DEFECTO
            : config.severity;

        function segundos(valor, porDefecto, minimo) {
            if (valor === undefined || valor === null || valor === "") return porDefecto;
            const n = Number(valor);
            return (Number.isFinite(n) && n >= minimo) ? n : NaN;
        }

        const ACTIVATE_S = segundos(config.activate_s, ACTIVAR_S, 1);
        const RELEASE_S = segundos(config.release_s, APAGAR_S, 1);
        const MARGIN = segundos(config.release_margin, 0, 0);

        // Motivos por los que el nodo no puede vigilar nada. Se avisan una vez al
        // arrancar y el nodo ignora lo que le llega: una alarma sin identidad
        // válida no se publica (el consumidor la rechazaría entera).
        const errores = [];

        if (!naturaleza.esUuidV4(VARIABLE_UUID)) errores.push("variable_uuid falta o no es un uuid v4 válido");
        if (!THRESHOLD_NAME) errores.push("falta el nombre del umbral que se vigila");
        if (!ALARM_NAME) errores.push("falta el nombre de la alarma");
        if (!naturaleza.esUuidV4(ALARM_UUID)) errores.push("alarm_uuid falta o no es un uuid v4 válido (usa «Generar»)");
        if (!naturaleza.SEVERIDADES.includes(SEVERITY)) errores.push('severity "' + SEVERITY + '" no existe; admitidas: ' + naturaleza.SEVERIDADES.join(", "));
        if (Number.isNaN(ACTIVATE_S)) errores.push("«Activar tras» tiene que ser de 1 s como mínimo");
        if (Number.isNaN(RELEASE_S)) errores.push("«Apagar tras» tiene que ser de 1 s como mínimo");
        if (Number.isNaN(MARGIN)) errores.push("el «Margen para apagar» no puede ser negativo");

        const valido = errores.length === 0;

        if (!valido) {
            node.error("alarm-generator: " + errores.join("; ") + ". El nodo no genera alarmas");
        }

        // =========================
        // ESTADO (una sola alarma: la de este umbral)
        // =========================
        // active           la alarma está abierta
        // pendiente        desde cuándo (ms) se mantiene el cambio que aún no se
        //                  confirma: la condición cumplida (alarma cerrada) o fuera
        //                  de la banda de apagado (alarma abierta). null = ninguno.
        // valorPendiente   la lectura de ese primer instante
        let active = false;
        let pendiente = null;
        let valorPendiente = null;

        // =========================
        // LECTURA DE LA ENTRADA
        // =========================
        // Acepta las dos formas que emiten los nodos de origen y solo atiende a la
        // variable elegida; el resto de mensajes se ignora.
        //  1) Muestra de module-production: variables[] con count y thresholds[]
        //     que ya traen condition_met, sobre [start_timestamp, timestamp] (s).
        //  2) Mensaje de una variable de modbus-variable: payload y thresholds[]
        //     "crudos", que aquí se evalúan; el instante es msg.timestamp (ms).
        function aMilisegundos(instante) {
            const n = Number(instante);
            if (!Number.isFinite(n) || n <= 0) return null;
            return n > 9999999999 ? n : n * 1000;
        }

        function observacion(msg) {

            if (Array.isArray(msg.variables)) {

                const v = msg.variables.find(x => x && naturaleza.normalizarUuid(x.variable_uuid) === VARIABLE_UUID);
                if (!v || !Array.isArray(v.thresholds)) return null;

                const t = v.thresholds.find(x => x && x.name === THRESHOLD_NAME);
                if (!t) return null;

                const valor = Number(v.count);
                const hasta = aMilisegundos(t.timestamp !== undefined ? t.timestamp : msg.end_range);
                const desde = aMilisegundos(t.start_timestamp !== undefined ? t.start_timestamp : msg.start_range);

                return {
                    umbral: t,
                    valor: valor,
                    unidad: v.unit || "",
                    cumple: typeof t.condition_met === "boolean" ? t.condition_met : naturaleza.evaluarUmbral(valor, t),
                    desde: desde === null ? (hasta === null ? Date.now() : hasta) : desde,
                    hasta: hasta === null ? Date.now() : hasta,
                    dispositivo: msg
                };
            }

            if (naturaleza.normalizarUuid(msg.variable_uuid) === VARIABLE_UUID && Array.isArray(msg.thresholds)) {

                const t = msg.thresholds.find(x => x && x.name === THRESHOLD_NAME);
                if (!t) return null;

                const valor = Number(msg.payload);
                if (!Number.isFinite(valor)) return null;

                const instante = aMilisegundos(msg.timestamp) || Date.now();

                return {
                    umbral: t,
                    valor: valor,
                    unidad: msg.unit || "",
                    cumple: naturaleza.evaluarUmbral(valor, t),
                    desde: instante,
                    hasta: instante,
                    dispositivo: msg
                };
            }

            return null;
        }

        // =========================
        // EMITIR ALARMA
        // =========================
        // timestamp es el instante real del cambio (cuándo empezó o terminó la
        // condición), no el del fin del retardo; value, la lectura en ese instante;
        // y threshold, el límite contra el que se comparó.
        function emitAlarm(obs, state, instante, valor) {

            const t = obs.umbral;
            const condicion = naturaleza.normalizarCondicion(t.condition);

            node.send({
                payload: {
                    device_uuid: obs.dispositivo.device_uuid,
                    device_name: obs.dispositivo.device_name,
                    catalog: "alarm-generator",
                    alarm_uuid: ALARM_UUID,
                    alarm_name: ALARM_NAME,
                    severity: SEVERITY,
                    state: state,
                    value: valor,
                    unit: obs.unidad,
                    variable_uuid: VARIABLE_UUID,
                    threshold: {
                        name: THRESHOLD_NAME,
                        condition: condicion,
                        value1: t.value !== undefined && t.value !== "" && t.value !== null ? Number(t.value) : null,
                        value2: condicion === "between" && t.value2 !== undefined && t.value2 !== "" && t.value2 !== null ? Number(t.value2) : null
                    },
                    timestamp: instante
                }
            });

            mostrarEstado();
        }

        function mostrarEstado() {
            if (!valido) {
                node.status({ fill: "red", shape: "ring", text: RED._("alarm-generator.status.invalid") });
            } else if (active) {
                node.status({ fill: "red", shape: "dot", text: RED._("alarm-generator.status.active") });
            } else if (pendiente !== null) {
                node.status({ fill: "yellow", shape: "ring", text: RED._("alarm-generator.status.activating") });
            } else {
                node.status({ fill: "green", shape: "dot", text: RED._("alarm-generator.status.ok") });
            }
        }

        // =========================
        // HISTÉRESIS
        // =========================
        // Los tiempos se miden con el instante de las lecturas, no con el reloj del
        // nodo. Si dejan de llegar lecturas el estado no cambia: la caída de
        // comunicación la avisa modbus-variable.
        //
        //   cerrada -> abierta  la condición se cumple durante ACTIVAR_S seguidos
        //   abierta -> cerrada  la lectura sale de la condición ampliada con el
        //                       margen durante APAGAR_S seguidos
        function evaluar(obs) {

            if (!active) {

                if (!obs.cumple) {
                    pendiente = null;
                    mostrarEstado();
                    return;
                }

                if (pendiente === null) {
                    pendiente = obs.desde;
                    valorPendiente = obs.valor;
                }

                if (obs.hasta - pendiente >= ACTIVATE_S * 1000) {
                    active = true;
                    const instante = pendiente;
                    const valor = valorPendiente;
                    pendiente = null;
                    emitAlarm(obs, 1, instante, valor);
                } else {
                    mostrarEstado();
                }

                return;
            }

            // Abierta: sigue mientras la lectura esté dentro de la condición ampliada.
            const sigue = MARGIN > 0
                ? naturaleza.evaluarUmbralConMargen(obs.valor, obs.umbral, MARGIN)
                : obs.cumple;

            if (sigue) {
                pendiente = null;
                return;
            }

            if (pendiente === null) {
                pendiente = obs.desde;
                valorPendiente = obs.valor;
            }

            if (obs.hasta - pendiente >= RELEASE_S * 1000) {
                active = false;
                const instante = pendiente;
                const valor = valorPendiente;
                pendiente = null;
                emitAlarm(obs, 0, instante, valor);
            }
        }

        // =========================
        // INPUT
        // =========================
        node.on('input', function (msg) {

            if (!valido || !msg) return;

            const obs = observacion(msg);
            if (!obs) return;

            if (!naturaleza.esUuidV4(obs.dispositivo.device_uuid)) {
                if (!node.avisoDispositivo) {
                    node.avisoDispositivo = true;
                    node.error('alarm-generator: device_uuid ("' + obs.dispositivo.device_uuid + '") no es un uuid v4 válido; se ignora la lectura');
                }
                return;
            }

            evaluar(obs);
        });

        if (valido) {
            node.status({ fill: "grey", shape: "ring", text: RED._("alarm-generator.status.waiting") });
        } else {
            mostrarEstado();
        }

        node.on('close', function () {
            active = false;
            pendiente = null;
        });
    }

    RED.nodes.registerType("alarm-generator", AlarmGeneratorNode);
};
