module.exports = function (RED) {

    const naturaleza = require("../../resources/naturaleza-variable");
    function ModuleProductionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // =========================
        // CONFIG
        // =========================
        const sc1 = config.sc1_topic;
        const sc2 = config.sc2_topic || "";
        const sp  = config.sp_topic  || "";

        const ENABLE_SC1 = true;
        const ENABLE_SC2 = !!sc2;
        const ENABLE_SP  = !!sp;

        // Intervalo de muestra (spec 010, D13): segundos entre muestras. Tiene que ser
        // uno de los divisores de 60 entre 1 y 60; ausente (un flujo anterior) es 1 s.
        // Un valor fuera de la lista se avisa y se toma 1 s.
        const SAMPLE_INTERVAL_S = (function () {
            const v = config.sample_interval;
            if (v === undefined || v === null || v === "") return 1;
            if (naturaleza.INTERVALOS_DE_MUESTRA.includes(Number(v))) return Number(v);
            node.error("sample_interval \"" + v + "\" no es válido; admitidos: "
                + naturaleza.INTERVALOS_DE_MUESTRA.join(", ") + " (segundos). Se usa 1 s");
            return 1;
        })();

        // Uso de la variable (spec 009). Cada sensor es una variable con nombre,
        // uuid, unidad, uso y umbrales propios. Un flujo anterior (papel sc1_role,
        // lista de umbrales común con "target", condiciones con símbolos) se
        // traduce aquí, así que sigue funcionando sin volver a guardarlo.
        // El uso decide nature y role: no hay valor por defecto, y un sensor sin uso
        // válido no se reporta (mismo tratamiento que un uuid ausente).
        function sensorDeConteo(sensor, etiqueta, activo) {

            if (!activo) return null;

            const variable = naturaleza.variableDeSensor(config, sensor);
            const errores = naturaleza.validarSensorDeConteo(variable);

            if (errores.length) {
                node.error(etiqueta + ": " + errores.join("; ") + ". El sensor no se reporta");
                return null;
            }

            const avisos = naturaleza.avisosDeConfiguracion(variable);

            // Un contador de producción sin su umbral de conteo cero se resume igual
            // de bien, pero nadie sabrá en qué segundos dejó de contar y su línea
            // no aparecerá parada nunca. Se avisa al arrancar, una vez.
            if (avisos.length) {
                node.error(etiqueta + ": " + avisos.join("; "));
            }

            return { ...variable, campos: naturaleza.camposDeVariable(variable) };
        }

        // Identificador de cada sensor (spec 007): obligatorio solo si el
        // sensor está activado (CA2). Sin uno válido, la variable no se
        // reporta — mismo tratamiento que una secuencia sin variable_uuid en
        // modbus-variable (E1), para no publicar identidad inventada (RN2).
        function variableUuidDeSensor(uuid, etiqueta, activo) {

            if (!activo) return null;

            if (!uuid || !naturaleza.esUuidV4(uuid)) {
                node.error(etiqueta + ': variable_uuid ausente o inválido; el sensor no se reporta');
                return null;
            }

            return uuid;
        }

        const UUID_SC1 = variableUuidDeSensor(config.uuid_sc1, "Count 1", ENABLE_SC1);
        const UUID_SC2 = variableUuidDeSensor(config.uuid_sc2, "Count 2", ENABLE_SC2);
        const UUID_SP  = variableUuidDeSensor(config.uuid_sp, "Presence", ENABLE_SP);

        const VAR_SC1 = sensorDeConteo("sc1", "Count 1", ENABLE_SC1);
        const VAR_SC2 = sensorDeConteo("sc2", "Count 2", ENABLE_SC2);

        // La presencia es solo un estado: sin unidad, sin umbrales, sin papel.
        const VAR_SP = ENABLE_SP
            ? { ...naturaleza.variableDeSensor(config, "sp"), campos: { nature: "state" } }
            : null;

        // =========================
        // PRODUCCIÓN
        // =========================
        let counts = {}, lastState = {}, lastChangeTime = {};

        [sc1, sc2, sp].forEach(t => {
            if (t) {
                counts[t] = 0;
                lastState[t] = 0;
                lastChangeTime[t] = Date.now();
            }
        });

        // =========================
        // ALARMAS CONFIG
        // =========================
        const THRESHOLD_DESALINEADO = parseInt(config.th_sc1_desalineado) || 6;
        const THRESHOLD_DESCONECTADO = parseInt(config.th_sp_desconectado) || 6;

        const BLOCKED_TIME_MS = (parseInt(config.th_sc1_blocked_sec) || 3) * 1000;
        const MISALIGNED_TIME_MS = (parseInt(config.th_sp_desalineado) || 10) * 60000;

        const COUNT1_BLOCKED_MS = (parseInt(config.th_sc1_blocked_min) || 10) * 60000;
        const COUNT2_BLOCKED_MS = (parseInt(config.th_sc2_blocked_min) || 10) * 60000;

        const ENABLE = {
            A1: (config.enable_alarm1 !== false) && ENABLE_SP,
            A2: (config.enable_alarm2 !== false) && ENABLE_SP,
            A3: (config.enable_alarm3 !== false),
            A4: (config.enable_alarm4 !== false) && ENABLE_SP,
            A5: (config.enable_alarm5 !== false),
            A6: (config.enable_alarm6 !== false) && ENABLE_SC2
        };

        // =========================
        // CONTEXTO
        // =========================
        let ctx = {
            lastPresenceState: 0,
            lastCount1State: 0,
            lastCount2State: 0,

            currentPresenceState: 0,
            currentCount1State: 0,
            currentCount2State: 0,

            presenceCount: 0,
            count1NoPresenceCount: 0,

            alarm1Active: false,
            alarm2Active: false,
            alarm3Active: false,
            alarm4Active: false,
            alarm5Active: false,
            alarm6Active: false,

            count1Start: null,
            count2Start: null,
            presenceMisalignedStart: null,

            // Spec 012: inicio real de las condiciones por conteo de pulsos
            // (A1 y A2): el primer pulso de la racha que luego llega al umbral.
            presenceStreakStart: null,
            count1NoPresenceStart: null
        };

        // =========================
        // EMIT ALARM
        // =========================
        // Spec 010 (C-01 v3): cada alarma lleva su catálogo y su alarm_uuid reservado
        // (A1-A6 son las 1-6 del catálogo module-production). El nombre no cambia:
        // es parte del contrato. La severidad la pone el consumidor por el uuid.
        // Spec 012: en la apertura (state 1) el timestamp es el inicio real de la
        // condición (extra.since, epoch ms), no el instante en que el temporizador
        // o el contador la detecta. El cierre (state 0) sigue llevando el instante
        // en que se observa.
        function emitAlarm(enabled, id, name, state, extra = {}) {
            if (!enabled) return;

            const reservada = naturaleza.alarmaReservada("module-production", id);

            node.send([null, {
                payload: {
                    device_uuid: config.device_uuid,
                    device_name: config.device_name,
                    catalog: "module-production",
                    alarm_uuid: reservada.alarm_uuid,
                    alarm_name: name,
                    state: state,
                    value: extra.value ?? null,
                    unit: extra.unit || "sec",
                    timestamp: (state === 1 && Number.isFinite(extra.since)) ? extra.since : Date.now()
                }
            }]);
        }
        // =========================
        // EMIT DEBUG
        // =========================
        function emitDebug(event = "") {

            if (!config.enable_debug) return;

            node.send([
                null,
                null,
                {
                    topic: "debug",
                    payload: {
                        timestamp: Date.now(),
                        event: event,

                        ctx: structuredClone(ctx),

                        counts: structuredClone(counts),

                        lastState: structuredClone(lastState),

                    diagnostics: {
                        differenceSP_SC1: ENABLE_SP
                            ? (counts[sp] || 0) - (counts[sc1] || 0)
                            : null,

                        differenceSC1_SC2: ENABLE_SC2
                            ? (counts[sc1] || 0) - (counts[sc2] || 0)
                            : null
                        },

                    config: {
                        sc1,
                        sc2,
                        sp,
                        ENABLE_SC1,
                        ENABLE_SC2,
                        ENABLE_SP
                        }
                    }
                }
            ]);
        }
        // =========================
        // UPDATE STATUS
        // =========================
        function updateStatus() {

            let fill = "green";

            // Prioridad alta: alarmas críticas
            if (ctx.alarm5Active || ctx.alarm6Active) {
                fill = "red";
            }
            // Prioridad media: alarmas de advertencia
            else if (
                ctx.alarm1Active ||
                ctx.alarm2Active ||
                ctx.alarm3Active ||
                ctx.alarm4Active
            ) {
                fill = "yellow";
            }

            // Construir texto de alarmas activas
            let alarmas = [];

            if (ctx.alarm1Active) alarmas.push("1🟨");
            if (ctx.alarm2Active) alarmas.push("2🟨");
            if (ctx.alarm3Active) alarmas.push("3🟨");
            if (ctx.alarm4Active) alarmas.push("4🟨");
            if (ctx.alarm5Active) alarmas.push("5🟥");
            if (ctx.alarm6Active) alarmas.push("6🟥");

            let alarmText = alarmas.length ? alarmas.join(" ") : "-";

            node.status({
                fill: fill,
                shape: "dot",
                text:
                    `S: ` +
                    `${ctx.currentCount1State ? "🟩" : "⬜"} ` +
                    `${ENABLE_SC2 ? (ctx.currentCount2State ? "🟩" : "⬜") : "-"} ` +
                    `${ENABLE_SP ? (ctx.currentPresenceState ? "🟩" : "⬜") : "-"} ` +
                    `A: ${alarmText}`
            });
        }
        // =========================
        // TIMER ALARMAS
        // =========================
        const timerAlarm = setInterval(() => {
            const now = Date.now();

            // A3
            if (ENABLE_SC1 && ctx.currentCount1State === 1 && ctx.count1Start && !ctx.alarm3Active) {
                if ((now - ctx.count1Start) > BLOCKED_TIME_MS) {
                    ctx.alarm3Active = true;

                    emitAlarm(ENABLE.A3, 3, "SENSOR DE CONTEO BLOQUEADO", 1, {
                        value: BLOCKED_TIME_MS / 1000,
                        unit: "sec",
                        since: ctx.count1Start
                    });
                }
            }

            // A4
            if (ENABLE_SP && ENABLE_SC1 &&
                ctx.currentPresenceState === 1 &&
                ctx.currentCount1State === 0 &&
                ctx.presenceMisalignedStart &&
                !ctx.alarm4Active) {

                if ((now - ctx.presenceMisalignedStart) > MISALIGNED_TIME_MS) {
                    ctx.alarm4Active = true;

                    emitAlarm(ENABLE.A4, 4, "SENSOR DE PRESENCIA DESALINEADO", 1, {
                        value: MISALIGNED_TIME_MS / 1000,
                        unit: "sec",
                        since: ctx.presenceMisalignedStart
                    });
                }
            }

            // A5
            if (ENABLE_SC1 && ctx.currentCount1State === 1 && ctx.count1Start && !ctx.alarm5Active) {
                if ((now - ctx.count1Start) > COUNT1_BLOCKED_MS) {
                    ctx.alarm5Active = true;

                    emitAlarm(ENABLE.A5, 5, "FALLA SENSOR DE CONTEO 1", 1, {
                        value: COUNT1_BLOCKED_MS / 1000,
                        unit: "sec",
                        since: ctx.count1Start
                    });
                }
            }

            // A6
            if (ENABLE_SC2 && ctx.currentCount2State === 1 && ctx.count2Start && !ctx.alarm6Active) {
                if ((now - ctx.count2Start) > COUNT2_BLOCKED_MS) {
                    ctx.alarm6Active = true;

                    emitAlarm(ENABLE.A6, 6, "FALLA SENSOR DE CONTEO 2", 1, {
                        value: COUNT2_BLOCKED_MS / 1000,
                        unit: "sec",
                        since: ctx.count2Start
                    });
                }
            }
            // Actualizar estado del nodo
            updateStatus();
        }, 1000);

        // =========================
        // INPUT
        // =========================
        node.on('input', function (msg) {
            const now = Date.now();
            const topic = msg.topic;
            const value = Number(msg.payload);

            if (counts.hasOwnProperty(topic)) {
                if (value !== lastState[topic]) {
                    lastChangeTime[topic] = now;
                    if (value === 1) counts[topic]++;
                }
                lastState[topic] = value;
            }

            // SC1
            if (ENABLE_SC1 && topic === sc1) {

                ctx.currentCount1State = value;

                if (value === 1 && ctx.lastCount1State === 0) {
                    ctx.count1Start = now;
                    ctx.presenceCount = 0;

                    if (ctx.alarm1Active) {
                        ctx.alarm1Active = false;
                        emitAlarm(ENABLE.A1, 1, "SENSOR DE CONTEO DESALINEADO", 0, {
                            value: THRESHOLD_DESALINEADO,
                            unit: "pulses"
                        });
                    }

                    if (ENABLE_SP && ctx.currentPresenceState === 0) {
                        ctx.count1NoPresenceCount++;
                        if (ctx.count1NoPresenceCount === 1) ctx.count1NoPresenceStart = now;
                        if (ctx.count1NoPresenceCount >= THRESHOLD_DESCONECTADO && !ctx.alarm2Active) {
                            ctx.alarm2Active = true;

                            emitAlarm(ENABLE.A2, 2, "SENSOR DE PRESENCIA DESCONECTADO", 1, {
                                value: THRESHOLD_DESCONECTADO,
                                unit: "pulses",
                                since: ctx.count1NoPresenceStart
                            });
                        }
                    } else {
                        ctx.count1NoPresenceCount = 0;
                    }

                    ctx.presenceMisalignedStart = null;
                }

                if (value === 0 && ctx.lastCount1State === 1) {

                    ctx.count1Start = null;

                    if (ctx.alarm3Active) {
                        ctx.alarm3Active = false;
                        emitAlarm(ENABLE.A3, 3, "SENSOR DE CONTEO BLOQUEADO", 0, {
                            value: BLOCKED_TIME_MS / 1000,
                            unit: "sec"
                        });
                    }

                    if (ctx.alarm5Active) {
                        ctx.alarm5Active = false;
                        emitAlarm(ENABLE.A5, 5, "FALLA SENSOR DE CONTEO 1", 0, {
                            value: COUNT1_BLOCKED_MS / 1000,
                            unit: "sec"
                        });
                    }

                    if (ENABLE_SP && ctx.currentPresenceState === 1) {
                        ctx.presenceMisalignedStart = now;
                    }
                }

                ctx.lastCount1State = value;
            }

            // SC2
            if (ENABLE_SC2 && topic === sc2) {

                ctx.currentCount2State = value;

                if (value === 1 && ctx.lastCount2State === 0) {
                    ctx.count2Start = now;
                }

                if (value === 0 && ctx.lastCount2State === 1) {

                    ctx.count2Start = null;

                    if (ctx.alarm6Active) {
                        ctx.alarm6Active = false;
                        emitAlarm(ENABLE.A6, 6, "FALLA SENSOR DE CONTEO 2", 0, {
                            value: COUNT2_BLOCKED_MS / 1000,
                            unit: "sec"
                        });
                    }
                }

                ctx.lastCount2State = value;
            }

            // SP
            if (ENABLE_SP && topic === sp) {

                ctx.currentPresenceState = value;

                if (value === 1 && ctx.lastPresenceState === 0) {

                    if (ctx.currentCount1State === 0) {
                        ctx.presenceCount++;
                        if (ctx.presenceCount === 1) ctx.presenceStreakStart = now;

                        if (ctx.presenceCount >= THRESHOLD_DESALINEADO && !ctx.alarm1Active) {
                            ctx.alarm1Active = true;

                            emitAlarm(ENABLE.A1, 1, "SENSOR DE CONTEO DESALINEADO", 1, {
                                value: THRESHOLD_DESALINEADO,
                                unit: "pulses",
                                since: ctx.presenceStreakStart
                            });
                        }

                        ctx.presenceMisalignedStart = now;
                    } else {
                        ctx.presenceCount = 0;
                    }
                }

                if (value === 0 && ctx.lastPresenceState === 1) {

                    ctx.presenceMisalignedStart = null;

                    if (ctx.alarm4Active) {
                        ctx.alarm4Active = false;
                        emitAlarm(ENABLE.A4, 4, "SENSOR DE PRESENCIA DESALINEADO", 0, {
                            value: MISALIGNED_TIME_MS / 1000,
                            unit: "sec"
                        });
                    }
                }

                ctx.lastPresenceState = value;
            }

            // RESET A2
            if (ENABLE_SP &&
                ctx.currentPresenceState === 1 &&
                ctx.currentCount1State === 1) {

                ctx.count1NoPresenceCount = 0;

                if (ctx.alarm2Active) {
                    ctx.alarm2Active = false;
                    emitAlarm(ENABLE.A2, 2, "SENSOR DE PRESENCIA DESCONECTADO", 0, {
                        value: THRESHOLD_DESCONECTADO,
                        unit: "pulses"
                    });
                }
            }
            // Actualizar estado del nodo
            updateStatus();
            emitDebug({
                topic: msg.topic,
                value: msg.payload
            });
        });
        
        // =========================
        // PRODUCCIÓN (una muestra por intervalo)
        // =========================
        // Los umbrales se evalúan en cada muestra sobre las botellas contadas en
        // ella. El intervalo (sample_interval, 1-60 s y divisor de 60, 1 s por
        // defecto) es el de la muestra: con 1 s una parada de 6 s dentro de 10 s se
        // ve y una de 14 s dura 14 s; una línea lenta (un producto cada 20 s)
        // elige un intervalo mayor para que casi todas las muestras no sean cero.
        // No es report_interval (el de versiones anteriores, que se ignora): el
        // paquete al concentrador lo agrega production-reporter en su propia
        // ventana. Cada muestra dice qué segundos cubre ([start_range, end_range])
        // para que production-reporter una las muestras seguidas en un tramo y pese
        // la presencia por lo que dura la muestra. Las alarmas A1-A6 tienen su
        // propio temporizador de 1 s y no dependen de este intervalo.
        let startRange = Math.floor(Date.now() / 1000);

        const timerProd = setInterval(() => {

            const now = Date.now();

            // Cada muestra cubre al menos un intervalo: un temporizador que se adelanta
            // no genera una muestra vacía ni la repite. Si el proceso se detuvo y se
            // retrasa, la muestra cubre todos los segundos que pasaron.
            const endRange = Math.max(startRange + SAMPLE_INTERVAL_S, Math.floor(now / 1000));

            let variables = [];

            // =========================
            // THRESHOLDS DE UNA VARIABLE
            // =========================
            function buildThresholds(variable, count) {

                return (variable.thresholds || []).map(t => ({
                    name: t.name,
                    condition: t.condition,
                    value: t.value,
                    value2: t.condition === "between" ? t.value2 : null,
                    condition_met: naturaleza.evaluarUmbral(count, t),
                    start_timestamp: startRange,
                    timestamp: endRange
                }));
            }

            // =========================
            // SC1 y SC2: dos variables de conteo independientes
            // =========================
            [
                { topic: sc1, uuid: UUID_SC1, variable: VAR_SC1 },
                { topic: sc2, uuid: UUID_SC2, variable: VAR_SC2 }
            ].forEach(sensor => {

                if (!sensor.topic || !sensor.uuid || !sensor.variable) return;

                const count = counts[sensor.topic] || 0;

                variables.push({
                    variable_uuid: sensor.uuid,
                    variable_name: sensor.variable.name,
                    topic: sensor.topic,
                    count: count,
                    state: lastState[sensor.topic] || 0,
                    unit: sensor.variable.unit,

                    // nature y role salen del uso: el sensor no los decide.
                    ...sensor.variable.campos,

                    thresholds: buildThresholds(sensor.variable, count)
                });
            });

            // =========================
            // SP: solo estado, sin unidad ni umbrales
            // =========================
            if (ENABLE_SP && UUID_SP && VAR_SP) {

                variables.push({
                    variable_uuid: UUID_SP,
                    variable_name: VAR_SP.name,
                    topic: sp,
                    count: counts[sp] || 0,
                    state: lastState[sp] || 0,
                    unit: "",

                    // La presencia es un estado, no un contador: no se suma.
                    ...VAR_SP.campos
                });
            }

            // =========================
            // EMITIR MUESTRA
            // =========================
            node.send([{
                device_uuid: config.device_uuid,
                device_name: config.device_name,
                start_range: startRange,
                end_range: endRange,
                variables: variables
            }, null]);

            // =========================
            // RESET
            // =========================
            Object.keys(counts).forEach(k => counts[k] = 0);

            startRange = endRange;
        
        }, SAMPLE_INTERVAL_S * 1000);

        node.on('close', function () {
            clearInterval(timerProd);
            clearInterval(timerAlarm);
        });
    }

    RED.nodes.registerType("module-production", ModuleProductionNode);
};