# node-red-contrib-mentor-capturer

Conjunto de nodos personalizados para Node-RED: lectura/escritura Modbus, reportes de producción, conteo de pulsos y simulación de datos.

## Nodos incluidos

| Nodo | Descripción |
|---|---|
| **device-reporter** | Reporta estadísticas de dispositivos IoT a intervalos configurables (segundos/minutos/horas) |
| **modbus-variable** | Lee variables Modbus con alarmas incorporadas |
| **modbus-registers-to-number** | Convierte registros Modbus crudos a valores numéricos |
| **number-to-modbus-registers** | Convierte valores numéricos a registros Modbus |
| **module-production** | Conteo de pulsos para producción industrial |
| **production-reporter** | Genera reportes periódicos de producción |
| **random-generator** | Generador de valores aleatorios para pruebas y simulación |

## Instalación

Desde el Palette Manager de Node-RED (Menu → Manage palette → Install), buscar `node-red-contrib-mentor-capturer`.

O vía terminal:

```bash
npm install node-red-contrib-mentor-capturer
```

## Dependencias

- [`modbus-serial`](https://www.npmjs.com/package/modbus-serial) — usado por los nodos de comunicación Modbus.
- [`node-red-contrib-modbus`](https://www.npmjs.com/package/node-red-contrib-modbus) — provee el config node "Modbus Client" requerido por el nodo **modbus-variable**.

## Requisitos

- Node-RED >= 2.0.0
- Node.js >= 14

## Licencia

MIT © Mentor Monitor
