module.exports = function (RED) {

    const alarmas = require("../../resources/alarmas");
    const naturaleza = require("../../resources/naturaleza-variable");

    // alarm-publisher (spec 010, C-32): convierte el mensaje de alarma de cualquiera
    // de las tres fuentes (salida 2 de module-production y de modbus-variable, y
    // alarm-generator) en el evento alarm-event/v1 y lo deja listo para un `mqtt out`
    // estándar: msg.topic = mentor_alarms/<device_uuid>, QoS 1, sin retener.
    //
    // No decide nada: cuándo hay alarma lo decide el nodo que la detecta. No tiene
    // cola ni reintentos: si el broker no está, el evento se pierde y lo corrige el
    // paquete del minuto, que sí pasa por la cola. Sin MQTT dentro de los nodos que
    // detectan, para que la misma lógica (y sus pruebas) valga en todos los flujos.
    function AlarmPublisherNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Un aviso por equipo y motivo, no uno por mensaje.
        const avisados = {};

        node.on("input", function (msg, send, done) {

            // Compatible con Node-RED < 1.0 (sin send/done).
            send = send || function () { node.send.apply(node, arguments); };

            const p = msg && msg.payload;
            const errores = alarmas.validarAlarma(p);

            if (errores.length) {

                const clave = (p && p.device_uuid) + "|" + errores.join("|");

                if (!avisados[clave]) {
                    avisados[clave] = true;
                    node.error("alarma no publicada: " + errores.join("; "));
                }

                node.status({ fill: "yellow", shape: "ring", text: RED._("alarm-publisher.status.invalid") });
                if (done) done();
                return;
            }

            const alarma = alarmas.normalizarAlarma(p);
            const evento = alarmas.construirEvento(alarma, Date.now(), naturaleza.nuevoUuidV4());

            send({
                topic: alarmas.PREFIJO_TOPIC + alarma.device_uuid,
                payload: evento,
                qos: 1,
                retain: false
            });

            node.status({
                fill: alarma.state === 1 ? "red" : "green",
                shape: "dot",
                text: RED._("alarm-publisher.status.last") + " " + alarma.alarm_name + " " + alarma.state
            });

            if (done) done();
        });

        node.status({ fill: "grey", shape: "ring", text: RED._("alarm-publisher.status.waiting") });
    }

    RED.nodes.registerType("alarm-publisher", AlarmPublisherNode);
};
