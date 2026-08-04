module.exports = function (RED) {
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
            presenceMisalignedStart: null
        };

        // =========================
        // EMIT ALARM
        // =========================
        function emitAlarm(enabled, id, name, state, extra = {}) {
            if (!enabled) return;

            node.send([null, {
                payload: {
                    device_uuid: config.device_uuid,
                    device_name: config.device_name,
                    alarm_id: id,
                    alarm_name: name,
                    state: state,
                    value: extra.value ?? null,
                    unit: extra.unit || "sec",
                    timestamp: Date.now()
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
                        unit: "sec"
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
                        unit: "sec"
                    });
                }
            }

            // A5
            if (ENABLE_SC1 && ctx.currentCount1State === 1 && ctx.count1Start && !ctx.alarm5Active) {
                if ((now - ctx.count1Start) > COUNT1_BLOCKED_MS) {
                    ctx.alarm5Active = true;

                    emitAlarm(ENABLE.A5, 5, "FALLA SENSOR DE CONTEO 1", 1, {
                        value: COUNT1_BLOCKED_MS / 1000,
                        unit: "sec"
                    });
                }
            }

            // A6
            if (ENABLE_SC2 && ctx.currentCount2State === 1 && ctx.count2Start && !ctx.alarm6Active) {
                if ((now - ctx.count2Start) > COUNT2_BLOCKED_MS) {
                    ctx.alarm6Active = true;

                    emitAlarm(ENABLE.A6, 6, "FALLA SENSOR DE CONTEO 2", 1, {
                        value: COUNT2_BLOCKED_MS / 1000,
                        unit: "sec"
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
                        if (ctx.count1NoPresenceCount >= THRESHOLD_DESCONECTADO && !ctx.alarm2Active) {
                            ctx.alarm2Active = true;

                            emitAlarm(ENABLE.A2, 2, "SENSOR DE PRESENCIA DESCONECTADO", 1, {
                                value: THRESHOLD_DESCONECTADO,
                                unit: "pulses"
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

                        if (ctx.presenceCount >= THRESHOLD_DESALINEADO && !ctx.alarm1Active) {
                            ctx.alarm1Active = true;

                            emitAlarm(ENABLE.A1, 1, "SENSOR DE CONTEO DESALINEADO", 1, {
                                value: THRESHOLD_DESALINEADO,
                                unit: "pulses"
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
        // PRODUCCIÓN
        // =========================
        let startRange = Math.floor(Date.now() / 1000);

        const timerProd = setInterval(() => {

            const now = Date.now();
            const endRange = Math.floor(now / 1000);

            let variables = [];

            // =========================
            // BUILD THRESHOLDS
            // =========================
            function buildThresholds(target, count) {

                const thresholds = config.thresholds || [];

                return thresholds
                    .filter(t => t.target === target)
                    .map(t => {

                    let condition_met = false;

                        switch (t.condition) {

                            case "==":
                                condition_met = count == t.value;
                            break;

                            case ">=":
                                condition_met = count >= t.value;
                            break;

                            case "<=":
                                condition_met = count <= t.value;
                            break;
                        }

                return {
                    name: t.name,
                    condition: t.condition,
                    value: t.value,
                    condition_met: condition_met,
                    timestamp: endRange
                };
            });
    }

    // =========================
    // SC1
    // =========================
    if (ENABLE_SC1) {

        const count = counts[sc1] || 0;

        variables.push({
            variable_name: "SENSOR DE CONTEO 1",
            topic: sc1,
            count: count,
            state: lastState[sc1] || 0,
            unit: "pulses",

            // NUEVO
            thresholds: buildThresholds("sc1", count)
        });
    }

    // =========================
    // SC2
    // =========================
    if (ENABLE_SC2) {

        const count = counts[sc2] || 0;

        variables.push({
            variable_name: "SENSOR DE CONTEO 2",
            topic: sc2,
            count: count,
            state: lastState[sc2] || 0,
            unit: "pulses",

            // NUEVO
            thresholds: buildThresholds("sc2", count)
        });
    }

    // =========================
    // SP
    // =========================
    if (ENABLE_SP) {

        variables.push({
            variable_name: "SENSOR DE PRESENCIA",
            topic: sp,
            count: counts[sp] || 0,
            state: lastState[sp] || 0,
            unit: "pulses"
        });
    }

    // =========================
    // EMITIR REPORTE
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

}, (config.report_interval || 10) * 1000);
        

        node.on('close', function () {
            clearInterval(timerProd);
            clearInterval(timerAlarm);
        });
    }

    RED.nodes.registerType("module-production", ModuleProductionNode);
};