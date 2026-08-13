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
| **alarm-generator** | Raises status alarms (1/0) from thresholds emitted by other nodes |

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
