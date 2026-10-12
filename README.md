# node-red-contrib-mentor-capturer

A set of custom Node-RED nodes: Modbus read/write, production reporting, pulse counting, and data simulation.

## Included nodes

| Node | Description |
|---|---|
| **device-reporter** | Reports IoT device statistics at configurable intervals (seconds/minutes/hours) |
| **modbus-variable** | Reads Modbus variables with built-in alarms |
| **modbus-registers-to-number** | Converts raw Modbus registers into numeric values |
| **number-to-modbus-registers** | Converts numeric values into Modbus registers |
| **module-production** | Pulse counting for industrial production |
| **production-reporter** | Generates periodic production reports |
| **random-generator** | Random value generator for testing and simulation |
| **alarm-generator** | Turns one threshold of one variable into an alarm, with hysteresis, release margin, severity and its own `alarm_uuid` |
| **alarm-publisher** | Publishes every alarm change at once as an `alarm-event/v1` message for a standard `mqtt out` node |

## Installation

From the Node-RED Palette Manager (Menu → Manage palette → Install), search for `node-red-contrib-mentor-capturer`.

Or via terminal:

```bash
npm install node-red-contrib-mentor-capturer
```

## Dependencies

- [`modbus-serial`](https://www.npmjs.com/package/modbus-serial) — used by the Modbus communication nodes.
- [`node-red-contrib-modbus`](https://www.npmjs.com/package/node-red-contrib-modbus) — provides the "Modbus Client" config node required by the **modbus-variable** node.
  > ⚠️ Intentionally pinned to version `5.45.2`, since later versions (5.46+) require Node.js >= 22. If your environment already runs Node.js 22 or later, you can manually install a newer version of `node-red-contrib-modbus` without issues.

## Requirements

- Node-RED >= 2.0.0
- Node.js >= 14

## Languages

Every node is available in English (en-US, the base) and Spanish (es-ES) through the standard Node-RED `locales/`
mechanism: labels, statuses, editor notices and help. Data is never translated: alarm names, threshold names and the
fields and values of the messages (`catalog`, `severity`, ...) are the same in every language.

## Alarms (Mentor patch)

- Every alarm message carries `catalog` (`module-production`, `modbus-variable` or `alarm-generator`) and `alarm_uuid`
  (a uuid v4 for `alarm-generator`; reserved uuids `00000000-0000-0000-<catalog>-<n>` for the nine known alarms)
  instead of the numeric `alarm_id`. The reporters group alarms by `(device_uuid, catalog, alarm_uuid)`.
- **alarm-generator** watches one threshold of one variable chosen in the editor from the node wired to its input,
  with activation and release delays (5 s / 10 s by default), a release margin, severity and the real instant of the change.
- **alarm-publisher** sends the alarm to `mentor_alarms/<device_uuid>` (QoS 1, not retained) through a standard `mqtt out`.
- **modbus-variable** opens its communication alarm after N failed cycles in a row (3 by default).
- **module-production** has a configurable sample interval (1 to 60 s, a divisor of 60, 1 s by default).

## Recent changes (1.1.0)

- Added the **alarm-generator** node: raises `state: 1`/`0` alarms by matching a configured name against the
  `thresholds[]` emitted by `module-production` or `modbus-variable`, supporting `gt`, `gte`, `lt`, `lte`, `eq`,
  `neq`, and `between` conditions.
- **device-reporter** and **production-reporter** now also emit `sum_squares` (Σx²) alongside `standard_deviation`
  in each variable's `summary` and in every threshold range — this makes exact re-aggregation of standard
  deviation across larger time windows (e.g. minute → hour → day) possible, since averaging standard deviations
  directly is not mathematically valid.
- **production-reporter** now rounds `sum`, `average`, `max`, `min`, `standard_deviation`, and `sum_squares` to
  2 decimal places, matching the precision already used by `device-reporter`.

## License

MIT © Mentor Monitor
