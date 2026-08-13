module.exports = function (RED) {
    function AlarmGeneratorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // =========================
        // CONFIG
        // =========================
        // Nombre del umbral a identificar (debe coincidir con el "name"
        // configurado en el nodo de origen, ej. module-production o modbus-variable).
        const ALARM_NAME = (config.alarm_name || "").trim();

        // Si no se define un id, por defecto es 1.
        const ALARM_ID = (config.alarm_id !== undefined && config.alarm_id !== "" && config.alarm_id !== null)
            ? parseInt(config.alarm_id)
            : 1;

        // =========================
        // ESTADO (una sola alarma a la vez)
        // =========================
        let active = false;

        // =========================
        // BUSCAR EL THRESHOLD POR NOMBRE
        // =========================
        // Soporta dos formatos de entrada:
        //  1) Reporte con variables[] (ej. module-production -> output 1)
        //  2) Mensaje de una sola variable con thresholds[] (ej. modbus-variable -> output 1)
        function findMatch(msg) {

            if (Array.isArray(msg.variables)) {
                for (const v of msg.variables) {
                    if (!Array.isArray(v.thresholds)) continue;
                    const t = v.thresholds.find(th => th.name === ALARM_NAME);
                    if (t) return { threshold: t, variable: v };
                }
                return null;
            }

            if (Array.isArray(msg.thresholds)) {
                const t = msg.thresholds.find(th => th.name === ALARM_NAME);
                if (t) return { threshold: t, variable: msg };
            }

            return null;
        }

        // =========================
        // EVALUAR CONDICIÓN
        // =========================
        // Si el threshold ya trae condition_met (module-production lo calcula),
        // se usa directo. Si no (modbus-variable manda el threshold "crudo"),
        // se calcula comparando el valor actual de la variable contra condition/value.
        function isConditionMet(threshold, variable) {

            if (typeof threshold.condition_met === "boolean") {
                return threshold.condition_met;
            }

            const current = Number(variable.count ?? variable.payload ?? variable.value);
            const target = Number(threshold.value);
            const target2 = Number(threshold.value2);

            switch (threshold.condition) {
                case "eq":
                case "==":      return current === target;
                case "neq":
                case "!=":      return current !== target;
                case "gt":
                case ">":       return current > target;
                case "gte":
                case ">=":      return current >= target;
                case "lt":
                case "<":       return current < target;
                case "lte":
                case "<=":      return current <= target;
                case "between": return current >= target && current <= target2;
                default:        return false;
            }
        }

        // =========================
        // EMITIR ALARMA
        // =========================
        // El "valor" que se reporta es el de la condición del threshold
        // (contra qué se comparó), no la lectura instantánea de la variable
        // — esa evaluación ya ocurrió en el nodo de origen.
        function emitAlarm(msg, variable, threshold, state) {
            node.send({
                payload: {
                    device_uuid: msg.device_uuid,
                    device_name: msg.device_name,
                    alarm_id: ALARM_ID,
                    alarm_name: ALARM_NAME,
                    state: state,
                    value1: threshold.value !== undefined && threshold.value !== "" ? Number(threshold.value) : null,
                    value2: threshold.value2 !== undefined && threshold.value2 !== "" ? Number(threshold.value2) : null,
                    unit: variable.unit || "",
                    timestamp: Date.now()
                }
            });

            node.status({
                fill: state === 1 ? "red" : "green",
                shape: "dot",
                text: state === 1 ? "ACTIVA" : "OK"
            });
        }

        // =========================
        // INPUT
        // =========================
        node.on('input', function (msg) {

            // Si no hay nombre de alarma configurado, no se emite nada.
            if (!ALARM_NAME) {
                return;
            }

            const match = findMatch(msg);
            if (!match) return;

            const { threshold, variable } = match;
            const conditionMet = isConditionMet(threshold, variable);

            if (conditionMet && !active) {
                active = true;
                emitAlarm(msg, variable, threshold, 1);
            } else if (!conditionMet && active) {
                active = false;
                emitAlarm(msg, variable, threshold, 0);
            }
        });

        node.status({ fill: "grey", shape: "ring", text: ALARM_NAME ? "esperando" : "sin nombre configurado" });

        node.on('close', function () {
            active = false;
        });
    }

    RED.nodes.registerType("alarm-generator", AlarmGeneratorNode);
};
