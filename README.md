# Zigbee Health

A self-hosted, alarm-first dashboard for devices across multiple Zigbee2MQTT
networks. Try the isolated simulation without connecting to a broker.

![Dashboard with synthetic demonstration devices](docs/dashboard.png)

## Features

- Priority alarm stack, acknowledgement notes and restored-alarm processing.
- Searchable, sortable, paginated issue and healthy-device tables.
- Multiple brokers/base topics, with broker and bridge outage detection.
- Offline, stale, low battery, weak LQI, missing inventory and repeated dropout
  conditions. Global thresholds, device overrides, persistence and hysteresis.
- Timed or indefinite device/category/network shunts. Actual health and history
  remain visible. Expiry rearms a continuing fault once.
- Device reports, battery/LQI charts, event timelines and CSV export.
- Retirement/restoration, confirmed history deletion and links for moved or
  replacement devices.
- SMTP fault/recovery notifications with duplicate suppression and delivery history.
- Editable **90-day default retention**. Working alarms, active shunts and current
  configuration survive history cleanup.

Built with React, Vite, Node.js 24, SQLite, MQTT.js and Nodemailer. This early
release uses one shared operator identity: **Local operator**.

## Local use

Install Node.js 24 and pnpm 11.25.0, then:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open <http://127.0.0.1:18920>. Simulation contains 64 synthetic devices, keeps
data in `data/simulation`, and cannot enable real broker or email connections.
To reset it, stop the app and remove only that simulation directory.

`pnpm start` opens a separate live workspace in `data/live` with no brokers and
email disabled. Add each network in Configuration, then enable its connection.
New broker entries start disabled. Simulation databases cannot open as live data.

For development, start the backend and run `pnpm dev` in another terminal. Vite
uses port 18921 and proxies the API to port 18920.

## Docker Compose

```sh
cp .env.example .env
# Set a unique ZIGBEE_HEALTH_PASSWORD of at least 12 characters in .env.
docker compose up --build -d
```

Default binding is loopback on port 18920. For trusted LAN access, set
`BIND_ADDRESS` to the host LAN address and `PUBLIC_HOST` to the hostname or IP
used in the browser. Review port and container/volume names before deployment.
Compose uses an unprivileged process, read-only root filesystem, private data
volume and no Docker socket. Use an authenticated HTTPS reverse proxy for remote
access; do not expose the unencrypted administrative interface to the internet.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Native bind address; Compose uses `0.0.0.0` internally |
| `PORT` | `18920` | Native port; Compose uses `8080` internally |
| `DATA_DIR` | `data/live` or `data/simulation` | Database/key directory |
| `PUBLIC_HOST` | empty | Additional permitted browser hostname |
| `APP_PASSWORD` | empty | Native login password; required outside loopback |
| `TZ` | `UTC` | IANA timezone for displayed timestamps, including DST |
| `BIND_ADDRESS` | `127.0.0.1` | Compose host bind address |
| `APP_PORT` | `18920` | Compose published port |
| `ZIGBEE_HEALTH_PASSWORD` | required | Compose login password |

The shared password provides no per-person audit attribution. The actor is
always Local operator.

## Device identity and lifecycle

Records use their network ID and Zigbee IEEE address. A friendly-name change on
the same network preserves history, settings and alarms. Matching names across
networks remain distinct.

- **Retire** stops collection and monitoring, closes working alarms with a retired
  outcome, suppresses queued notifications and cancels device shunts. History
  remains within retention. Rediscovery does not reactivate the device. This
  does not unpair it from Zigbee2MQTT.
- **Restore** resumes monitoring with a fresh baseline. Old battery, signal and
  availability values do not imply health; a new live report is required.
- **Link previous** connects a retired record to its successor. Moved devices
  must share the same IEEE address; replacement hardware has a different address.
  Reports navigate between records while keeping measurements and alarms
  separate. Links can be removed with an audit reason.
- **Delete history** requires retirement, the current device name, the literal
  `DELETE HISTORY` and a reason. This removes the record's samples, incidents,
  delivery records, device shunts and past events from the current database.
  The retired identity, settings, links and a new deletion audit entry remain
  to prevent automatic rediscovery. Existing backups are unchanged.

Inventory disappearance raises a missing-device condition rather than silently
deleting a record. Retired identities and structural links survive pruning.

## Monitoring and email

The collector subscribes to existing Zigbee2MQTT inventory, state, availability
and events. It publishes no queries, controls, scans or MQTT will. Read-only broker
ACLs are recommended; publish permission is unnecessary. Each broker/base-topic
entry represents one network.

Retained sensor messages do not establish a live baseline. Non-retained receipt
time is not proof of a newly sampled physical measurement. Source outages suspend
device classification instead of declaring every device offline. Signal is
**LQI**, never invented dBm. Tune timeouts for sleepy devices; availability depends
on your existing bridge configuration.

Configure SMTP in Email. Use TLS/STARTTLS for authenticated SMTP. Acknowledgements
and shunts suppress pending fault messages. An accepted alarm can have one
recovery message. “Accepted” means SMTP acceptance, not inbox delivery. Ambiguous
attempts remain uncertain and are never automatically retried.

## Storage and backup

SQLite keeps five-minute measurement summaries and individual incident/event
transitions. Cleanup runs hourly. Eligible old history expires under the retention
threshold; working alarms, active shunts and configuration remain independent.
Backup retention is separate.

Passwords are encrypted with a separate `secrets.key`. Protect the whole data
directory: the database and key together permit decryption. Never commit data,
`.env`, backups or real diagnostics.

Create an explicit online backup to a new directory:

```sh
node server/backup.mjs data/live/health.db /private/backups/new-backup
```

It includes the database, matching key and integrity/hash manifest. No schedule
is installed. Restore both `health.db` and `secrets.key` while the app is stopped
and point `DATA_DIR` at that private directory. Keep live/simulation backups separate.

## Development

```sh
pnpm test
pnpm build
```

Tests use synthetic records, loopback brokers and a local SMTP sink. CI also
builds and smoke-tests the container. Real broker and email compatibility depend
on deployment configuration; no production data is included here.

See [CONTRIBUTING.md](CONTRIBUTING.md). Redact addresses, names, credentials and
personal information before sharing issues, logs or screenshots.

## License

[MIT](LICENSE), copyright Zigbee Health contributors. Dependencies retain their
own licenses. No code from other Zigbee dashboards is included.
